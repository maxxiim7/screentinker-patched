# #148 — server eviction-storm robustness (field-safe net)

**Status: investigation + fix spec. No code changed, nothing deployed.**

This is the FIELD-SAFE NET for #148: it makes the SERVER absorb a client that opens
duplicate/rapid sockets, so a thrashing device converges to ONE stable connection and stays
online — protecting devices that will never get the APK fix (the duplicate-socket root cause
is a separate task). Complementary to the APK fix; likely shippable as server-only 1.9.2-patch2.

## Confirmed eviction behaviour (ws/deviceSocket.js)

- **`evictPriorSocket(deviceId, exceptSocketId)`** looks up the device's current connection
  (`heartbeat.getConnection`) and, if it's a different socket, `oldSocket.disconnect(true)` —
  the **OLD** socket is dropped ("io server disconnect" on that client). Single-session
  enforcement: the newest register wins, the prior is evicted. Called on the reconnect path
  (line 486) and the fingerprint/pairing path (line 397), **after** both rate gates.

- **Eviction does NOT bypass the limiters.** The register handler runs, in order:
  `flapLimiter.check` (line ~325) → `validateDeviceToken` → `reconnectThrottle.check`
  (line ~469) → **then** `evictPriorSocket` (line 486). A reconnect must pass both gates
  before it evicts anyone.

- **Why 8-in-9s tripped neither gate:**
  - *Flap-limiter* = `connectRateMax 20 / 5min`. 8-in-9s is far under it — it correctly does
    nothing (it targets a device flapping over a LONG window, not a 9-second burst).
  - *Reconnect-throttle* = `reconnectBaseMax 5 / reconnectWindowMs 10s` — which 8-in-9s WOULD
    trip… **except during the `reconnectWarmupMs` (30s) cold-start window, where only the hard
    ceiling (20/10s) applies** (`if (warmup) return allow(...)`). 8 < 20 → allowed.
    **The patch1 deploy restarted the container, so the observed storm was almost certainly
    inside that 30s warm-up** — every device reconnecting after a restart is warm-up-lenient,
    and a *thrashing* device is undamped for those 30s.
  - This matches the evidence exactly: **flat loop, no flap/throttle fires, pure eviction
    churn** — eviction is cheap (a disconnect + a register), so the server stays healthy.

- **Post-warm-up, the server ALREADY absorbs it.** Once the 30s warm-up passes, the throttle
  rejects the 6th+ reconnect and `return`s **before** `evictPriorSocket` — so the **incumbent
  socket is preserved** and the device stays online while the duplicate is refused. So the
  robustness gap is specifically the **warm-up window after every restart/deploy**, plus the
  churn itself (the authoritative socket flipping N times) even when it ends online.

## One thrashing client, or two instances?

**Socket.IO's `io server disconnect` does NOT auto-reconnect the client** (unlike
`transport close`/`ping timeout`). So an *evicted* socket's client does **not** come back on
its own — the 8 fresh sockets are the **client explicitly opening new connections**, i.e. the
APK duplicate-socket bug (one buggy instance opening repeatedly, and/or ≥2 service instances
each with its own socket). It is **not** an eviction→reconnect loop. Definitive attribution
(one instance vs two) needs the MAXHUB `logcat`, but the server pattern rules out
"eviction causes the reconnect." Consequence for the fix: the net must tolerate a client that
keeps opening duplicates, and simply **stop the churn and keep the device online on one socket**.

## The risk to close

1. **Warm-up churn (every restart/deploy):** for 30s a thrasher's sockets all pass, each
   evicting the prior → the device's authoritative socket flips N times → dashboard
   online/offline thrash, and a race between "evict old / register new" can briefly leave the
   device with no live socket. It usually ends online on the last socket *if the client
   settles* — but nothing forces it to settle.
2. **The device following the wrong socket:** heartbeats key on `device_id` and update the one
   tracked connection, which points at the newest-registered socket. If the client's bug keeps
   advancing which socket it heartbeats, the tracked socket can go stale between flips.

## Fix spec — a warm-up-independent per-device SESSION-SETTLE debounce (do NOT implement yet)

Add a per-device settle window around eviction, checked in the register handler **just before
`evictPriorSocket`**, independent of the reconnect-throttle warm-up so it works right after a
restart:

- Track `sessionSettle: device_id -> { untilMs, socketId }`.
- On a genuine new register for X (post-auth):
  - **If X has a LIVE incumbent socket and `now < untilMs` and the new socket ≠ the held one:**
    this is a rapid duplicate → **SOFT-REFUSE the NEW socket** (`device:throttled
    {reason:'session_settle', retry_after_ms}` + disconnect the NEW socket) and **keep the
    incumbent**. Do NOT evict. The device stays online on the held socket; the duplicate is
    dropped (and, being `io server disconnect`, won't auto-reconnect).
  - **Liveness safeguard:** only refuse if the incumbent is genuinely alive (its socket is in
    the `/device` namespace). If the incumbent has died/gone, ACCEPT the new socket (a genuine
    takeover after the incumbent dropped) — never strand a device on a dead held socket.
  - **Else** (no live incumbent, or window elapsed): ACCEPT — `evictPriorSocket` + register as
    today, and set `sessionSettle[X] = { untilMs: now + SESSION_SETTLE_MS, socketId }`.
- `SESSION_SETTLE_MS` env-tunable, ~2–3s: long enough to swallow a duplicate burst, short
  enough that a genuine device MOVE (real new socket after the incumbent is gone or the window
  passed) is accepted within seconds.

**Why prefer the incumbent (hold), not the newest:** the incumbent is the connection already
receiving heartbeats and proven live; holding it avoids the flip-churn entirely, and the
liveness safeguard means we never keep a dead one. (Prefer-newest was considered — it tracks
the app's latest socket but keeps flipping, and can't tell which duplicate the app will
heartbeat; hold-incumbent + a short window + the liveness safeguard is simpler and stays
online. A fuller convergence when the app advances its own socket is the APK fix's job — the
server net's contract is "stop the churn, stay online.")

**Alignment with the limiters / patch1:**
- This is a **soft refusal** (like the flap soft cooldown), **never a quarantine** — a paired,
  thrashing device is calmed, not locked out (reuses patch1's paired-safe philosophy).
- Single-session enforcement is intact: exactly one authoritative socket; a legitimate move
  still replaces cleanly once the incumbent is gone or the short window elapses.
- Genuinely abusive/unpaired flapping is unchanged — it still meets the flap-limiter over the
  long window and the reconnect-throttle's hard ceiling.
- Cheap and O(1) per register; no loop impact (the storm was already flat-loop).

*(Also consider raising the confidence of the existing net: the reconnect-throttle warm-up
leniency is what let the storm through — but warm-up exists so a full-fleet reconnect after a
deploy isn't throttled. The settle debounce is the right lever because it dampens a SINGLE
thrashing device_id without touching the fleet-reconnect leniency.)*

### Tests
- **Storm converges:** one device_id opens N sockets in a few seconds (in AND out of the
  warm-up window) → it ends with exactly ONE stable authoritative socket, stays `online`
  throughout, and is NOT hard-quarantined (paired) — no evict↔reconnect churn.
- **Legitimate single move:** a device with a dead/absent incumbent opening one new socket is
  accepted immediately (old replaced cleanly); single-session still enforced.
- **Liveness safeguard:** if the held incumbent dies during the window, the next new socket is
  accepted (not stranded).
- **Abuse still caught:** an unpaired/unprovisioned flap is still limited (flap-limiter /
  reconnect-throttle hard ceiling).
- **Health:** under an N-socket storm the loop stays flat (no maintenance/flap impact).

## Framing

Field-safe relief that works on **un-updated devices tonight** — it caps the server's own
contribution to the thrash (churn + the warm-up gap) and keeps a thrashing paired device
ONLINE on one connection. It does **not** fix the client opening duplicates (the APK
duplicate-socket bug) — that remains the root fix. Shippable as server-only **1.9.2-patch2**.
