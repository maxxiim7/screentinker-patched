# #148 / #147 — "mass simultaneous disconnect" analysis (investigate-first)

**Status: analysis only. No code changed, nothing deployed.**

## Headline (the FIX-or-CARRY verdict Dan needs)

**v1.9.2 does NOT fix #148/#147, and telling Bold to upgrade to it as "the fix" is not
supported by the evidence — it may make the visible symptom worse.**

- The disconnect is **client-initiated and MAXHUB-specific**, per #148's own server logs and
  the clean same-server comparison (a Fire TV Stick on the *same server, same APK, same
  network* stays connected; the MAXHUB drops). The server does **not** initiate it.
- The bug reproduces on **every APK in the fleet (1.9.0 → 1.9.2)**, and **1.9.2's Android
  player socket code is byte-identical to beta5** — the only android change between them is
  the `versionCode` bump in `build.gradle.kts`. So the 1.9.2 APK will behave **identically**.
- Worse: **1.9.2 ADDS a flap-limiter with a 30-minute in-memory quarantine that beta5 does
  not have.** A MAXHUB that flaps (which is exactly what #148 describes) will be throttled
  *and then quarantined* more aggressively on 1.9.2 than on beta5 — i.e. it may "go offline
  and stop retrying" **faster**.
- The one genuine server-side fix in 1.9.2 (the event-loop-freeze death spiral) is real but
  addresses a **different** failure mode that is **not** present in #148 (there is no freeze,
  no restart, no server-initiated close in the #148 logs).

**Recommendation: walk back the "upgrade to 1.9.2 fixes this" advice.** The fix must target
the MAXHUB Android client's WebSocket lifecycle, not the server.

---

## Phase 0 — the evidence (and the contradiction in the framing)

There are two competing narratives, and the primary evidence resolves them:

**#148 body + server logs (empirical):**
- "Fire TV Stick on the **same APK, same network, same server** stays connected indefinitely
  — this is **MAXHUB-specific**."
- "Every disconnect is **client-initiated** — server sees a clean disconnect with the 5000ms
  offline-transition deferral, then nothing."
- "No errors, no blocks, no quarantine, **no throttle except after rapid reconnect cycling**
  (throttle correctly identified the flapping)."
- Trigger point: **after the initial content load completes** ("connect, register/pair,
  receive content, then drop"), then loops connecting/waiting, then stops retrying.

**Bold's later comment (the inference the task framing is built on):**
- "mass simultaneous disconnect across separate physical locations proving the trigger is
  server-side."

**These contradict, and the primary evidence wins:** a server-side mass event would be
*server-initiated* (the logs say client-initiated) and would drop the *Fire TV too* (it
doesn't). So "server-side" is not supported.

### Disconnect timing / periodicity
There is **no fixed interval or wall-clock trigger** in #148. The trigger is a **per-device
lifecycle event — completion of the initial content load.** The *appearance* of periodicity /
simultaneity is a **reporting artifact** (see below), not a server clock.

### Server-initiated vs missed-heartbeat — **missed-heartbeat, client-initiated**
The server never closes these sockets. Per the logs it observes the **client** close (clean
transport disconnect), starts the 5s offline-transition deferral (the #146 reconnect
containment), then marks the device offline because no heartbeat/registration follows.

---

## Phase 1 — proof there is NO server-side mass-disconnect (1.9.2 / current main)

Audited every path that can drop a device socket:

| Mechanism | Can it close sockets? | Can it fire fleet-wide at once? |
|---|---|---|
| **Heartbeat checker** (`services/heartbeat.js`) | **No** — it `UPDATE devices SET status='offline'` in the DB (line 29) and deletes the in-memory conn; it **never** calls `disconnect()`. Line 45 is a *safety* `continue`-if-the-socket-is-still-live. | Marks *offline in the DB* in a batch each 10s tick, but does not disconnect anything. |
| **Flap limiter / reconnect throttle** | Yes — refuses a *register* and `disconnect(true)`s **that one socket** | Only per-identity: a device is refused only if **it** exceeds 20 connects/5min. Not global. |
| **Operator block** | Yes — one socket, only a `blocked=1` device | No |
| **Evict-prior-socket** | Yes — the device's **own** previous socket on reconnect | No |
| **`protectSocket`** (`safe-socket.js`) | Yes — the one socket whose handler threw | No |
| **Maintenance / prune** | No — chunked, yields; touches tables, not sockets | No |
| Global teardown (`io.disconnectSockets()`, namespace close, timer) | **Does not exist** | — |

There is **no code path that disconnects many device sockets simultaneously.** The only
"batch, periodic" behavior is the heartbeat checker **marking devices offline in the DB** —
which is the server *reporting* that clients are gone, not *making* them gone.

**Reconciling "mass simultaneous" without a server disconnect:** the MAXHUBs drop their own
sockets (staggered, but correlated in time because they finish the initial content load
around the same moment — e.g. after a content push or a shared power event). The heartbeat
checker then flips a *batch* of them to `offline` on a single 10s tick (plus the 5s
deferral), so the **CMS dashboard shows a synchronized offline wave** that never corresponds
to a synchronized server *disconnect*. That reporting artifact is the "mass simultaneous"
signal — and it behaves the same on beta5 and 1.9.2.

---

## Phase 2 — FIX or CARRY (1.9.2 vs 1.9.2-beta5)

| Path | beta5 | 1.9.2 (main) | Effect on #148 |
|---|---|---|---|
| **Android player socket/reconnect code** | — | **byte-identical** (only `versionCode` bumped) | **Neither fixes nor changes it.** The client bug is untouched. |
| **Heartbeat checker** | live-socket guard + marks offline, no close | same | No change to the offline-reporting artifact. |
| **`pruneStatusLog`** | whole-table `ROW_NUMBER` sort (40–48s freeze) | `chunkedDelete` (non-blocking) | Fixes the **freeze/death-spiral** — a *different* failure mode, **not seen in #148** (no freeze/restart in the logs). |
| **Flap limiter + 30-min quarantine** | **absent** | **present** (`lib/flap-limiter.js`, 20/5min → quarantine) | **CARRY / WORSEN:** a flapping MAXHUB is now throttled *and quarantined* — it will "stop retrying / go offline" **sooner** than on beta5. |

**Verdict:** For the actual #148 mechanism (client-side drop), 1.9.2 is **inert** where it
matters (identical client code, no server disconnect) and **counterproductive** on the
secondary dynamic (the new flap-limiter quarantines the flapping client harder).

### Reconciling the one success row (Fire TV, 1.9.2 staging, days)
The clean isolation is in #148 itself: **same server, same APK, same network → Fire TV
survives, MAXHUB drops.** The variable is the **device**, not the server. The task's other
row (beta7 APK, beta5-prod vs 1.9.2-staging) confounds device *and* server and therefore
can't isolate anything; the staging row also happens to be a **single idle device** (no
fleet, tiny `device_status_log`, no flapping to throttle) — which removes every *secondary*
aggravator too. Net: the survival tracks the **MAXHUB-vs-FireTV device difference**, with
"staging = one idle device" masking the flap-limiter aggravation on top.

**Most likely client root cause** (to be confirmed with MAXHUB `logcat`, the "not yet
captured" item in #147): MAXHUB firmware/WebView power- or memory-management throttling or
killing the app's socket/JS timers **after the heavy initial content load**, so the Engine.IO
ping/pong lapses and the client closes — then its rapid reconnects trip the server throttle
(and, on 1.9.2, the flap quarantine), ending in "offline, stops retrying." Fire TV's
resource/power handling doesn't do this.

### What would falsify this conclusion
- MAXHUB `logcat` showing the **server** sent a close/`device:auth-error`/throttle *before*
  the client closed (would move blame server-ward).
- The Fire TV Stick *also* dropping under real fleet load on the same server (would reopen a
  load/server-side theory).
Capturing the MAXHUB `logcat` at the moment of disconnect is the single highest-value missing
evidence.

---

## Proposed fix (do NOT implement in this task)

1. **Client (the real fix):** in the MAXHUB/Android player, harden the socket lifecycle after
   initial sync — a foreground service + partial wakelock to keep the socket alive, an
   app-level heartbeat/keepalive independent of the WebView timer, and a reconnect policy that
   backs off but **never permanently stops retrying**. Confirm against MAXHUB `logcat` first.
2. **Server mitigation (reduces the *symptom*, not the cause):** since the flap limiter now
   punishes a flapping MAXHUB harder, consider making it **more forgiving for
   identified/paired devices** (raise `CONNECT_RATE_MAX`, or exempt a known device_id from
   quarantine) so a client with a flaky socket keeps getting let back in instead of being
   quarantined for 30 min. This makes 1.9.2 no worse than beta5 for this case while the client
   fix is developed.
3. **Do not** tell Bold that upgrading the server to 1.9.2 resolves #148/#147.
