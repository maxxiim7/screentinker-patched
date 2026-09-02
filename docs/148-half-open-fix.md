# #148 — half-open death: mechanism, synchronization, and fix ownership

**Status: investigation + fix spec. No code changed, nothing deployed.**

## Headline (corrects the leading assumption)

The premise "the SERVER sits on a half-open socket and never detects it" is **empirically
false.** The Socket.IO server **actively pings and closes dead peers** — I confirmed it closes
a non-ponging socket in `pingInterval + pingTimeout` (**1005ms** in a 500/500 test → **~60s in
prod at 30/30**). And the server **hands those ping values to the client** in the Engine.IO
handshake, so a compliant client runs the *same* ~60s dead-server detector.

Therefore:
- **The per-device fix is NOT "make the server detect half-open" — it already does.**
- The MAXHUB "no retry" is a **client-side recovery failure** (its Engine.IO ping-timeout
  isn't recovering the socket) that a server change **cannot fully fix over a severed TCP** —
  the server's close frame can't reach a client whose TCP is dead.
- The **simultaneity is Bold-edge or a reporting artifact**, not a 1.9.2 server mechanism.

**A server-only 1.9.2.x patch can HELP (tighten detection via lower ping values, add
SO_KEEPALIVE, stop the flap-limiter amplifying, make offline↔socket consistent) but is NOT
proven sufficient alone.** Full resolution likely needs the client watchdog + Bold's edge fix.
This is stated against the Phase-B gate below.

---

## Phase A — server-side detection (confirmed by test)

| Behavior | Finding |
|---|---|
| Socket.IO `pingInterval`/`pingTimeout` | **30000 / 30000** (set, not default-off). Server sends a ping every 30s and **closes on missed pong** → dead-peer detection in **≤60s**. **Empirically verified** (`/tmp/halfopen.cjs`: 500/500 → closed at 1005ms). |
| Client parameterization | The handshake open-packet carries `pingInterval`/`pingTimeout`; `socket.io-client:2.1.0` (EIO4) uses them for its **own** ping-timeout → the client also has a ~60s dead-server detector, **driven by the server's values**. |
| SO_KEEPALIVE | **NOT set** anywhere. The OS never independently probes; Engine.IO ping is the only detector. |
| `mark-offline` vs socket close | The heartbeat checker flips DB status to `offline` at **45s** and **does NOT close the socket**; Engine.IO closes it separately at **≤60s**. So the "offline-but-open" divergence is **bounded to ~15s**, not indefinite — but the two are not explicitly consistent. |
| Server "sits forever" theory | **REFUTED.** The socket is gone within ~60s. |

**Consequence:** because the client's detector is *parameterized by the server*, lowering the
server's ping values **tightens the client's half-open detection without an APK update** — the
one genuine server-only lever, and only useful **if the client's timer fires at all**.

---

## Phase B — the synchronization GATE (explicitly addressed)

Half-open explains the *per-device* hang. For fleet-wide simultaneity, the candidates:

1. **Server tick / event-loop freeze** — a pause > pingTimeout would make **every** client's
   ping-timeout fire at once (true simultaneous mass disconnect). **RULED OUT on 1.9.2:** the
   chunked prune removed the freeze; alpha runs clean for days; #148 logs show no freeze/
   restart. (This *was* the beta5 mechanism — the 40–48s `ROW_NUMBER` prune freeze paused the
   loop past pingTimeout → the whole fleet ping-timed-out together. It is the link between the
   old "death spiral" and a genuine mass disconnect, and 1.9.2 fixed it.)
2. **Bold's edge — conntrack / session-table flush** behind the single SNAT IP: a periodic
   firewall event (NAT table timeout, policy reload, session flush) severs **all flows behind
   that IP simultaneously** → every device goes half-open at the same instant. True
   simultaneity, edge-owned.
3. **Reporting artifact** — staggered client half-open deaths, then the **10s heartbeat checker
   marks a batch offline on one tick** (plus the 5s deferral), so the CMS shows a synchronized
   *offline wave* that does **not** correspond to a synchronized *sever*.

**Verdict on the gate:** the per-device mechanism is real, and simultaneity is explainable —
but I **cannot yet discriminate (2) a true edge-sever from (3) a reporting artifact** without
Bold's data. What I *can* state firmly: **on 1.9.2 there is no server-side synchronizer** (the
freeze is gone), so a true simultaneous *sever* would have to be edge (2). The disconnect-
interval from #148 and whether the Fire TV *also* momentarily blips are the discriminators
(questions below). **This is the honest "not fully proven" the gate asks for — the fix must not
pretend the simultaneity is ours to fix.**

**Fire TV reconciliation:** same network + server + APK, survives for days → its stack's
client-side ping-timeout fires and it reconnects cleanly (self-heals within ~60s; a brief blip
goes unnoticed). The MAXHUB on the identical path does not recover — the difference is
**client-side recovery**, not the server or the edge (both hit the Fire TV too).

---

## Phase C — the reconnect amplifier (ours, under SNAT)

- A **one-shot mass reconnect** from the single SNAT IP is **NOT refused**: each device carries
  its own `device_id` → per-device flap bucket → one connect each, well under 20/5min. The
  flap-limiter is identity-keyed (SNAT-safe), and reconnects carry `device_id` (not `anon`).
  ✅ recovery from a single flush is not blocked.
- **BUT** a *repeated* flush→reconnect cycle (or a reconnect that immediately re-drops) makes a
  device accumulate connects → trips its own **20/5min → 30-min quarantine** → reconnects
  refused → **sustained offline**. Because all devices trip ~together, this reads as a
  synchronized fleet-wide lockout. **This is 1.9.2-only** (beta5 has no flap-limiter) and turns
  a recoverable blip into a long outage. It must be fixed (Phase D-4).

---

## Does it exist in 1.9.2 as cut? / is the fix server-only?

- The **server-detection gap does not exist** in 1.9.2 (it closes dead peers in ≤60s).
- What **does** exist in 1.9.2 and is worth patching: (a) no SO_KEEPALIVE; (b) 60s detection is
  slower than it needs to be, and the *client* window is server-parameterized so we can tighten
  it without an APK; (c) `mark-offline` and socket-close aren't explicitly consistent; (d) the
  **flap-limiter can amplify** a reconnect storm into a fleet-wide quarantine.
- **Server-only reach:** items (a)–(d) are a legitimate **1.9.2.x server patch, no fleet APK
  update** — and (b) tightens the *client's* detector for free. **But** if the MAXHUB's
  client-side timer genuinely doesn't fire (true "no retry"), no server change wakes it over a
  dead TCP → a **client watchdog is still required**, and the **edge synchronizer is Bold's**.
  So: **ship the server patch (it strictly helps and de-risks the rollout), but do not tell
  Bold it is guaranteed to fix #148 until the MAXHUB logcat shows the client recovers.**

---

## Fix spec (propose; do NOT implement until green-lit)

**Server (1.9.2.x, no APK):**
1. **Tighten ping cadence** — e.g. `PING_INTERVAL=20000`, `PING_TIMEOUT=20000` (→ ~40s
   detection on both server AND client, since the client reads these). Do not go so low that
   transient loop-lag false-disconnects healthy clients; gate/adjust with the existing loop-lag
   band if lag is elevated. Env-driven, so tunable per deployment.
2. **SO_KEEPALIVE** — `httpServer.on('connection', s => s.setKeepAlive(true, 20000))` (or on
   engine.io's transport) as OS-level defense-in-depth.
3. **Make mark-offline consistent with socket state** — when the heartbeat checker marks a
   device offline, also `disconnect(true)` any lingering socket for it, so DB-offline can never
   diverge into a silent half-open (and, on a one-directional break, the client is signalled).
4. **Flap-limiter amplifier fix** — do NOT escalate a **paired `device_id`** to the 30-min
   quarantine on reconnect churn (keep the soft reconnect-throttle for loop protection; a known
   device with a flaky link must keep being let back in). Scope strictly to paired devices so
   genuine anon/unidentified flappers are still limited — do **not** weaken the flap-limiter
   globally or reintroduce the load risk it exists to prevent.

**Client (Android APK — the real per-device fix, separate release):**
5. **App-level liveness watchdog:** `device:heartbeat` with an **ACK + timeout**; on a missed
   ack force `socket.disconnect(); socket.connect()`. Detects half-open in ~15–25s regardless
   of the lib/OEM timer behavior. (Requires a server `device:heartbeat` ack.)

**Bold (edge):** raise/disable the Sophos WS idle/session timeout for the host; **disable
SSL/DPI inspection** for it; confirm no reverse proxy with a short WS read timeout.

### Tests
- **Server closes a dead peer within pingTimeout** — a client that completes the handshake then
  stops ponging is disconnected within `pingInterval+pingTimeout` (already demonstrated:
  `/tmp/halfopen.cjs`, 500/500 → 1005ms). Add as a regression at a short env timeout.
- **offline ⇒ closed** — after the heartbeat checker marks a device offline, assert no open
  socket remains for it (Phase D-3).
- **SNAT mass reconnect not refused** — N distinct `device_id`s reconnecting once each from the
  same IP are all admitted (flap-limiter identity-keyed); and a *repeated* cycle for a **paired**
  device is not quarantined (Phase D-4).
- **Client (instrumented/emulator):** after a silent transport kill, the watchdog forces a
  reconnect within the ack-timeout window.
