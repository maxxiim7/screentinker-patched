package com.remotedisplay.player.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #234 follow-up: a playlist refresh emits a full device:register, and PlaylistController.next()
 * asked for one on EVERY item advance. On a 10-second image that is six full re-registrations a
 * minute, per device, forever — each running 7+ server statements and the identity path, and each
 * replying with a full playlist push. Measured on the reproduction: 9 item plays, 9 registrations.
 *
 * The heartbeat already pulls a fresh playlist every 60s, so the per-item call was duplicating a
 * refresh that happens anyway.
 */
class RefreshThrottleTest {

    private val NOW = 5_000_000L
    private val MIN = RefreshThrottle.MIN_INTERVAL_MS

    @Test fun the_very_first_refresh_always_goes_through() {
        // A device that has never asked must not be held back by an empty timestamp.
        assertTrue(RefreshThrottle.shouldRefresh(lastAtMs = 0L, nowMs = NOW))
    }

    @Test fun THE_BUG_a_second_refresh_moments_later_is_suppressed() {
        // Two item advances a few seconds apart: the second must not re-register.
        assertFalse(RefreshThrottle.shouldRefresh(NOW - 3_000, NOW))
        assertFalse(RefreshThrottle.shouldRefresh(NOW - 10_000, NOW))
    }

    @Test fun once_the_interval_has_passed_it_refreshes_again() {
        assertTrue(RefreshThrottle.shouldRefresh(NOW - MIN, NOW))
        assertTrue(RefreshThrottle.shouldRefresh(NOW - (MIN + 1), NOW))
    }

    @Test fun just_under_the_interval_is_still_suppressed() {
        assertFalse(RefreshThrottle.shouldRefresh(NOW - (MIN - 1), NOW))
    }

    @Test fun it_sits_under_the_heartbeat_pull_so_the_two_interleave() {
        // The heartbeat refreshes every 60s. A window at or above that would systematically
        // suppress the heartbeat's own pull, which is the one we are relying on to remain.
        assertTrue(MIN < 60_000L)
    }

    @Test fun a_backwards_clock_never_wedges_refreshing() {
        // Signage panels correct their clocks. A future 'last' must not disable refresh until the
        // clock catches up — that would strand a device on a stale playlist for hours.
        assertTrue(RefreshThrottle.shouldRefresh(NOW + 3_600_000, NOW))
    }

    @Test fun a_ten_second_item_collapses_from_six_refreshes_a_minute_to_about_one() {
        // Walk a minute of 10s items and count what actually gets through.
        var last = 0L
        var allowed = 0
        var t = NOW
        repeat(6) {
            if (RefreshThrottle.shouldRefresh(last, t)) { allowed++; last = t }
            t += 10_000
        }
        assertTrue("expected roughly one refresh per minute, got $allowed", allowed <= 2)
    }
}
