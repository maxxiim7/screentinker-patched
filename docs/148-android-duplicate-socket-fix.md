# #148 — ROOT-CAUSE fix: stop the Android player opening duplicate sockets

**Status: code fix + tests + verification spec. NOT bumped/signed/released — Dan builds & signs
with the BMG keystore and schedules the (unreliable) fleet push.** 1.9.2-patch2 (server net)
protects field devices that won't get this APK.

## Phase 0 — the duplication surface (confirmed from the code)

`WebSocketService.connect()` was **unconditional**: every call ran `disconnect()` then opened a
`forceNew = true` socket. It is reachable from many entry points, each of which fired it blindly:

| Entry point | Path |
|---|---|
| Boot | `BootReceiver` → `Relauncher.relaunch()` → `startForegroundService` **+** launches `MainActivity` |
| Activity bind | `MainActivity.onServiceConnected` → `connect()` (line 75); also line 603 |
| Provisioning | `ProvisioningActivity` → `connect(url)` (line 133) |
| Foreground re-bind | `MainActivity` re-created / re-bound (`BIND_AUTO_CREATE`) → `onServiceConnected` → `connect()` again |
| Service restart | `START_STICKY` re-delivery |

So **any repeated bind/foreground transition re-invoked `connect()`, which threw away a healthy
socket and opened a new one** → the server saw a new socket for the same `device_id`, evicted
the prior, and the client (never auto-reconnecting on `io server disconnect`) opened yet another
on the next bind → the **8-in-9s storm** from `device_id 432ec739`.

### One instance vs two?

**One service instance, re-triggered — not two parallel instances.** Android guarantees a single
`WebSocketService` instance per process (no `android:process` in the manifest; started + bound
converge on one instance; a hard-kill takes the socket with the process). The logcat's two events
— BOOT_COMPLETED start (~09:08:33) and the `PROC_STATE_TOP` re-bind (`isBindService:true`,
~09:13:09) — are **two triggers of the same instance's unconditional `connect()`**, not two live
owners: the boot flow binds MainActivity → `connect()` (socket 1); the foreground re-bind fires
`onServiceConnected` again → `connect()` (socket 2, …). Fire TV never re-binds like that, so it
never reproduced on the identical server — consistent with a lifecycle-driven re-`connect()`, not
a server bug.

Per the brief, the fix ships **all** layers regardless — it guards the **socket** (invariant),
not the service/bind count (which varies by ROM), so it also covers a hypothetical second instance.

## Phase 1 — the fix (all layers, shipped together)

**`ConnectionGuard`** (new, pure/testable — the service is the shell, mirroring `OtaThrottle`):
`shouldOpenNewSocket(hasSocket, sameUrl, socketActive)` → reuse iff we already hold a socket to
the **same url** that is **live or self-healing**; open a new one only when there is none usable.

**`WebSocketService`:**
- **Idempotent `connect()` (primary).** `@Synchronized`; consults `ConnectionGuard` and **reuses**
  a live/reconnecting socket — every entry point can call it freely and only ONE socket is ever
  open. The socket-creation body is split into `private openSocket(url)`.
- **Single owner.** `onStartCommand` now calls `connect()` so the **service** owns the one
  connection (not whichever Activity happens to bind); idempotent, so a `START_STICKY` restart
  reuses rather than duplicates. `socketActive` / `currentUrl` track the one socket.
- **Reconnect discipline.** On `io server disconnect` / `io client disconnect` (which Socket.IO
  does **not** auto-reconnect) the socket is marked inert and **exactly one** re-open is scheduled
  after a 3s backoff (`scheduleReopen`, single-pending) — never a blind immediate re-open that
  gets evicted again. A transport drop keeps `socketActive = true` so Socket.IO's own backoff
  reconnect is reused (no parallel socket).
- **ROM lifecycle.** The `@Synchronized` idempotent guard + service-owned connection hold across
  the MAXHUB FGS restart/rebind (the "FGS started from background…" quirk that exposed the bug):
  a rebind reuses, a restart reuses.

These layers do not conflict — the singleton socket guard is primary; single-owner + reconnect
discipline are defense-in-depth against the vectors that vary by device.

## Phase 2 — verification

**Automated (harness exists — JVM JUnit):** `ConnectionGuardTest` (5 tests, green) proves the
invariant, including `idempotentAcrossManyRapidBinds` — 8 rapid binds against a live socket all
**reuse**, none open a duplicate (the storm, in miniature). Full `:app:testDebugUnitTest` green
(ConnectionGuard 5, OtaThrottle 7, ScheduleEval 1).

**Manual (on a MAXHUB, since the unit test can't exercise the real Android lifecycle):**
```
adb logcat -c && adb logcat | grep -E "Connected to server|Registered as|reusing existing socket|Disconnected from server"
```
- Reboot the panel, then toggle foreground several times (Home, re-open the app; force a
  `PROC_STATE_TOP` transition). **Expect:** exactly **one** "Connected to server" + one "Registered
  as …" per genuine (re)connection, and **"reusing existing socket … no duplicate"** on the
  redundant binds — **not** a burst of connects/registers.
- **Server-side reconcile:** the device shows on **one stable socket** with **no `io server
  disconnect` / eviction churn** in the server log (and the patch2 debounce should no longer be
  refusing `session_settle` duplicates from this device).

## Deliverable / hand-off

- Code: `ConnectionGuard.kt` (new), `WebSocketService.kt` (idempotent connect + single owner +
  reconnect discipline), `ConnectionGuardTest.kt` (new). Compiles; unit tests green.
- **Not** bumped/signed/released — Dan builds & signs with the BMG keystore and schedules the
  fleet push. **1.9.2-patch2 (server net) covers devices that won't receive this APK.**
- Recommend confirming on a real MAXHUB via the manual steps above before the fleet push (fleet
  APK updates are unreliable, so prove it on one panel first).
