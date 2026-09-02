package com.remotedisplay.player.service

/**
 * v4 canonical liveness contract — the pure, unit-testable decision logic for the client-side
 * half-open watchdog (no Android / Socket.IO deps, same pattern as [ConnectionGuard] /
 * [OtaThrottle]). WebSocketService is the imperative shell: it tracks lastServerMessageAt (ANY
 * inbound refreshes it), arms only after a device:heartbeat-ack (degrade-safe), and on each
 * heartbeat tick asks THIS object whether a connected-but-silent socket is half-open and, if so,
 * whether the anti-thundering-herd backoff allows a reconnect now.
 *
 * ANTI-THUNDERING-HERD (must not become the flood #143/#149 fixed): the THRESHOLD is jittered
 * (45s ± up to 10s) so a fleet doesn't all declare half-open at once under a shared cause (server
 * load delaying acks), and the reconnect BACKOFF is exponential-with-jitter (1,2,4,8,16… capped,
 * ±20%) so repeated failures spread out and back off instead of hammering. Load-adaptation is by
 * the client's OWN ack-silence — there is deliberately NO status/health poll (that is itself a
 * second herd).
 *
 * Canonical defaults match the .wgt and /player so all three exhibit identical on-the-wire
 * behavior; a platform-driven deviation would be documented here.
 */
object LivenessWatchdog {
    const val THRESHOLD_BASE_MS = 45_000L    // v4 canonical: 45s …
    const val THRESHOLD_JITTER_MS = 10_000L  // … ± up to 10s
    const val BACKOFF_BASE_MS = 1_000L       // v4 canonical: 1s, 2s, 4s, 8s, 16s …
    const val BACKOFF_CAP_MS = 30_000L       // … capped (within the contract's ~30–60s band)
    private const val BACKOFF_JITTER_FRACTION = 0.2 // … each ± ~20%

    /**
     * Watchdog threshold with jitter: 45s ± up to 10s. [rand] is a uniform value in [0, 1)
     * (injected so the pure logic is testable); the result is in [35s, 55s).
     */
    fun thresholdMs(rand: Double): Long =
        THRESHOLD_BASE_MS + ((rand - 0.5) * 2 * THRESHOLD_JITTER_MS).toLong()

    /**
     * Exponential reconnect backoff with ±20% jitter. [attempt] is 1-based (the 1st reconnect
     * uses the 1s step). Steps double (1s,2s,4s,8s,16s,…) and saturate at [BACKOFF_CAP_MS]; the
     * shift is clamped so a large attempt count can't overflow.
     */
    fun backoffMs(attempt: Int, rand: Double): Long {
        val steps = (attempt - 1).coerceIn(0, 20)
        val base = minOf(BACKOFF_BASE_MS shl steps, BACKOFF_CAP_MS)
        val jitter = ((rand - 0.5) * 2 * BACKOFF_JITTER_FRACTION * base).toLong()
        return base + jitter
    }

    /**
     * HALF-OPEN decision: reconnect only when a socket that is [connected] (Socket.IO still
     * reports it up — the state its own auto-reconnect can't see) and whose liveness we have
     * [armed] (seen ≥1 heartbeat-ack — degrade-safe: an ack-less/old server never arms us) has
     * been silent longer than [thresholdMs]. Pure; mirrors the .wgt's watchdogShouldReconnect.
     */
    fun isHalfOpen(armed: Boolean, connected: Boolean, silenceMs: Long, thresholdMs: Long): Boolean =
        armed && connected && silenceMs > thresholdMs

    /** Backoff gate: a new reconnect attempt is allowed only once the backoff for the current
     *  attempt count has elapsed since the last one — spaces repeated failures fleet-wide. */
    fun mayReconnectNow(msSinceLastAttempt: Long, backoffMs: Long): Boolean =
        msSinceLastAttempt >= backoffMs
}
