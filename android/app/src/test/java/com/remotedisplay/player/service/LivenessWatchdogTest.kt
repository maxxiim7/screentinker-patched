package com.remotedisplay.player.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v4 liveness-contract conformance for the pure watchdog decision logic. Proves:
 *  - degrade-safe (never fires unarmed) and the connected+silent half-open condition,
 *  - the anti-thundering-herd guarantees: threshold jitter (45s ± up to 10s) and exponential
 *    reconnect backoff with jitter (1,2,4,8,16… capped, ±20%) are PRESENT (not fixed values).
 */
class LivenessWatchdogTest {

    // ---- degrade-safe + half-open decision ----

    @Test fun `unarmed never fires — degrade-safe against an ack-less server`() {
        // Even a connected socket silent well past threshold must NOT reconnect until armed by an ack.
        assertFalse(LivenessWatchdog.isHalfOpen(armed = false, connected = true, silenceMs = 999_999, thresholdMs = 45_000))
    }

    @Test fun `disconnected never fires — that is Socket_IO's job, not the watchdog's`() {
        assertFalse(LivenessWatchdog.isHalfOpen(armed = true, connected = false, silenceMs = 999_999, thresholdMs = 45_000))
    }

    @Test fun `armed + connected + silent past threshold IS half-open`() {
        assertTrue(LivenessWatchdog.isHalfOpen(armed = true, connected = true, silenceMs = 46_000, thresholdMs = 45_000))
    }

    @Test fun `armed + connected but within threshold is healthy`() {
        assertFalse(LivenessWatchdog.isHalfOpen(armed = true, connected = true, silenceMs = 30_000, thresholdMs = 45_000))
    }

    // ---- anti-herd: threshold jitter 45s ± up to 10s ----

    @Test fun `threshold is centered on 45s and stays within ±10s`() {
        assertEquals(45_000L, LivenessWatchdog.thresholdMs(0.5))
        assertEquals(35_000L, LivenessWatchdog.thresholdMs(0.0))
        assertEquals(54_999L, LivenessWatchdog.thresholdMs(0.99995)) // ~55s upper bound (exclusive)
        for (i in 0..100) {
            val t = LivenessWatchdog.thresholdMs(i / 100.0)
            assertTrue("threshold $t out of [35s,55s)", t in 35_000..55_000)
        }
    }

    @Test fun `threshold has jitter — different rands give different thresholds (not fixed)`() {
        assertTrue(LivenessWatchdog.thresholdMs(0.1) != LivenessWatchdog.thresholdMs(0.9))
    }

    // ---- anti-herd: exponential backoff 1,2,4,8,16… capped, ±20% jitter ----

    @Test fun `backoff doubles per attempt then saturates at the cap`() {
        // rand=0.5 => no jitter, so we see the exact base curve.
        assertEquals(1_000L, LivenessWatchdog.backoffMs(1, 0.5))
        assertEquals(2_000L, LivenessWatchdog.backoffMs(2, 0.5))
        assertEquals(4_000L, LivenessWatchdog.backoffMs(3, 0.5))
        assertEquals(8_000L, LivenessWatchdog.backoffMs(4, 0.5))
        assertEquals(16_000L, LivenessWatchdog.backoffMs(5, 0.5))
        assertEquals(30_000L, LivenessWatchdog.backoffMs(6, 0.5))  // 32s -> capped at 30s
        assertEquals(30_000L, LivenessWatchdog.backoffMs(50, 0.5)) // no overflow at large attempts
    }

    @Test fun `backoff jitter is ±20% of the step and present (not fixed)`() {
        // attempt 5 base = 16s; ±20% => [12.8s, 19.2s].
        assertEquals(12_800L, LivenessWatchdog.backoffMs(5, 0.0)) // -20%
        assertEquals(19_200L, LivenessWatchdog.backoffMs(5, 1.0)) // +20%
        assertTrue(LivenessWatchdog.backoffMs(5, 0.2) != LivenessWatchdog.backoffMs(5, 0.8))
    }

    @Test fun `mayReconnectNow gates on the backoff having elapsed`() {
        assertTrue(LivenessWatchdog.mayReconnectNow(msSinceLastAttempt = 2_000, backoffMs = 1_000))
        assertTrue(LivenessWatchdog.mayReconnectNow(msSinceLastAttempt = 1_000, backoffMs = 1_000))
        assertFalse(LivenessWatchdog.mayReconnectNow(msSinceLastAttempt = 500, backoffMs = 1_000))
    }
}
