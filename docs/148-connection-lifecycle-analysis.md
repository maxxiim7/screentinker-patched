# #148 — WebSocket connection-lifecycle analysis (idle-reap / half-open)

**Status: investigation + mitigation spec. No code changed, nothing deployed.**

## Headline

Idle-reap by Bold's edge is a plausible **trigger**, but it is **not the whole story**, and a
keepalive alone will not fix it. Two facts constrain the diagnosis:

1. **The client already sends traffic every 15s** (`device:heartbeat`) plus receives a
   Socket.IO ping every 30s — so a *pure idle-timer* above ~15–30s should never reap this
   socket. If Bold's firewall still reaps it, the cause is DPI/SSL-inspection or a sub-15s
   timeout, **not** simple idleness — and more keepalive won't help.
2. **A Fire TV Stick survives on the SAME network + SAME server + SAME APK** (#148). Whatever
   Bold's edge does, a well-behaved client rides through it. So the decisive difference is the
   **client's ability to detect and recover from a silent (half-open) drop** — and the MAXHUB
   build has a real gap there.

**The fix is client self-heal + server half-open detection; the firewall config is a
secondary trigger-reducer.** None of this is fixed by v1.9.2 (the APK socket code is
unchanged), so this needs a new player build.

---

## Phase 0 — the keepalive stack (exact values, current main / 1.9.2)

**Server (`server/config.js`, `server/server.js`):**
- Socket.IO `pingInterval = 30000`, `pingTimeout = 30000` → **server→client ping every 30s**;
  worst-case dead-socket detection = **60s**. (Engine.IO v4: the *server* pings, the client
  pongs; these are real WebSocket frames, so a firewall that counts frames sees traffic.)
- `heartbeatTimeout = 45000` → server marks a device **offline** after 45s with no
  `device:heartbeat`. Marking offline **only flips DB status; it does NOT close the socket.**
- **No `setKeepAlive`/SO_KEEPALIVE** anywhere → the OS never independently detects a dead
  peer; the server relies solely on the 60s Engine.IO ping-timeout.
- Transports: Socket.IO default (polling→websocket upgrade allowed). No websocket-only lock.

**Client (Android, `WebSocketService.kt`):**
- `reconnection = true`, `reconnectionAttempts = MAX_VALUE` (infinite), delay 1s→60s, jitter
  0.5, connect `timeout = 20000`. **Configured to retry forever.**
- App-level **`device:heartbeat` every 15s** (every 4th → playlist pull). **Fire-and-forget,
  no ACK**, and guarded by `if (socket.connected() != true) return`.
- Runs as a **foreground service (mediaPlayback) + PARTIAL_WAKE_LOCK** → not subject to Doze.
- **No app-level liveness watchdog** — no last-server-message tracking, no forced reconnect;
  it trusts `socket.connected()` and the socket.io-client-java Engine.IO ping-timeout.

---

## Phase 1 — the half-open / silent-death crux

A firewall idle-reap (or SSL-inspection session drop) typically kills the TCP **silently — no
FIN** — leaving both ends half-open.

**Server:** holds the socket "connected" until its next ping gets no pong → closes on
`pingTimeout` (~30–60s), then marks offline at 45s. With **no SO_KEEPALIVE**, 60s is the best
it can do. Acceptable, but slow, and it never proactively probes TCP health.

**Client — the gap:** it has **no independent liveness check**. On a half-open socket,
`socket.connected()` still returns `true` (the lib hasn't noticed), so the 15s heartbeat keeps
firing into the void and **`EVENT_DISCONNECT` may never fire** → the infinite-reconnect logic
**never triggers** → the device sits on a dead socket = **"no retry."** Recovery depends
entirely on the socket.io-client-java Engine.IO ping-timeout firing; if it's slow or missed on
the MAXHUB's OkHttp/network stack, the client is stuck until the app/service restarts.

This exactly matches #148: *server sees a clean/eventual disconnect, then nothing; the client
loops or stops retrying.* The two sub-cases (both consistent, distinguished only by MAXHUB
`logcat`):
- **(a) half-open undetected** → client never reconnects ("no retry").
- **(b) client does reconnect** but a rapid reap→reconnect cycle trips the server flap-limiter
  → 30-min quarantine → reconnects refused → "loops connecting/waiting, then offline."

**Fire TV reconciliation:** on the *same network + server + APK*, the Fire TV survives — so
its network stack detects the half-open (or keeps the socket warm) and reconnects cleanly,
riding through the same edge behavior the MAXHUB can't. The "1.9.2 staging, days" row adds a
second reason (a single idle device with no fleet, no flapping, and possibly no aggressive
firewall in staging) — but the **clean same-network comparison isolates the difference to the
client's half-open handling.**

---

## Phase 2 — server-side contributor ruling

| Candidate | Verdict |
|---|---|
| **Per-IP / total connection cap** (SNAT'd fleet = one IP) | **CLEARED.** No `maxConnections`, no per-IP handshake limit. The flap-limiter keys on **identity** (device_id→fingerprint→token→anon), never IP — SNAT-safe. |
| **ScreenTinker's own proxy** (nginx/short WS read timeout) | **CLEARED.** The image runs `CMD ["node","server.js"]` — no proxy layer. Any WS timeout is on **Bold's edge**. |
| **Anon-bucket collapse under SNAT** | **CLEARED for reconnects.** A reconnect carries the saved `device_id` → per-device bucket, not `anon:global`. |
| **Flap-limiter / reconnect-throttle** | **IMPLICATED as an AMPLIFIER.** A reconnect on a fresh socket has `currentDeviceId=null` → `isRefreshConnect=false` → it **counts** toward the 20-connects/5-min limit. A repeated reap→reconnect cycle trips it → **30-min in-memory quarantine** → a recoverable blip becomes a 30-min offline. Because every device behind the edge gets reaped together, each trips its *own* limit at ~the same time → a **fleet-wide, synchronized-looking quarantine** (not via a shared bucket — via synchronized independent tripping). This is 1.9.2-only (beta5 has no flap-limiter). |

---

## Phase 3 — mitigation spec (propose; do NOT implement yet)

### Fixes from OUR side (make it self-heal regardless of Bold's edge)
1. **Client half-open watchdog (the primary fix).** Add an app-level liveness probe: send
   `device:heartbeat` **with an ACK callback + a timeout** (e.g. ack expected within 10s); on a
   missed ack, `socket.disconnect(); socket.connect()` (force a fresh reconnect). Equivalently,
   track the last inbound server message and force-reconnect if none for >45s (> the 30s
   pingInterval). This detects half-open death in ~15–25s regardless of the lib, and doubles as
   the keepalive. Requires the server to ACK the heartbeat (or emit `device:heartbeat-ack`).
   **This is an Android-APK change — it is NOT in v1.9.2.**
2. **Server SO_KEEPALIVE.** `socket.setKeepAlive(true, ~30000)` on accepted connections so the
   OS surfaces a dead peer independently of the 60s Engine.IO ping-timeout — faster, more
   reliable server-side half-open detection.
3. **Don't let the flap-limiter amplify a reap.** For an already-**paired device_id**, don't
   escalate to the 30-min quarantine on reconnect churn (keep the soft reconnect-throttle for
   loop protection, but a known device with a flaky link must keep being let back in). Scope
   the exemption to paired device_ids so genuine anon/unidentified flappers are still limited —
   **do not defeat the flap-limiter globally.**

### Keepalive cadence (workaround — reduces the trigger, doesn't fix recovery)
- The client already emits every 15s; the server pings every 30s. If Bold's timeout is a plain
  idle-timer, this **already** defeats it. If reaping persists, it's DPI/SSL-inspection — a
  keepalive can't fix that. Optionally tighten server `pingInterval` to ~25s as cheap insurance
  (still far below the flap threshold, no load concern). **The heartbeat-with-ack in (1) is the
  real keepalive+detector; a bare keepalive is not sufficient.**

### Fix vs. workaround
- **Fixes it (our side):** client heartbeat-with-ack + force-reconnect (1), server SO_KEEPALIVE
  (2), flap-limiter paired-device exemption (3). With these, any silent drop self-heals in
  ~15–60s and is never amplified into a 30-min lockout — independent of the firewall.
- **Bold should still set (their side):** raise/disable the Sophos WebSocket idle/session
  timeout for the ScreenTinker host; **disable SSL/DPI inspection** for that host (DPI is the
  most likely reason a 15s-active socket still gets reaped); confirm no reverse proxy with a
  short WS read timeout. These reduce how often the reap fires, but are not a substitute for
  client self-heal.

---

## Questions for Dan to send Bold

1. **Disconnect interval during quiet periods** (from #148): is it a round number
   (60/120/300s)? A fixed round interval ⇒ idle/session-timeout confirmed. Irregular ⇒
   half-open/other.
2. **Sophos model + config:** the WebSocket/idle/session-timeout value on the ScreenTinker
   host; is **SSL/deep-packet inspection** enabled for that host (this is the prime suspect for
   reaping a socket that already has 15s traffic)?
3. **Reverse proxy?** Any nginx / HAProxy / Cloudflare Tunnel / load balancer in front of the
   ScreenTinker Docker container, and its WebSocket read/idle timeout?
4. **MAXHUB `logcat` at the moment of a drop** (the decisive missing evidence): does it log
   `EVENT_DISCONNECT` (client detected the drop → recovery is the throttle/quarantine story) or
   **nothing** (half-open undetected → the client-watchdog fix is required)?
5. Does the same MAXHUB survive when pointed at a server **with no firewall in the path** (e.g.
   direct/LAN)? Confirms edge involvement vs. a pure client timer bug.
