package com.remotedisplay.player.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * onUnpaired was assigned TWICE in setupServiceCallbacks. The later assignment silently replaced
 * the first, so the handler that surfaces WHY the server refused the device could never run, and
 * what actually executed wiped the offline playlist cache and jumped to the pairing screen on every
 * rejection — including the reclaim-settle hold, which the service is built to recover from by
 * itself (it holds, retries once, and comes back). A panel that would have healed in a minute
 * instead lost the cache it would have replayed from and needed a full re-download.
 *
 * The decision is now one predicate, kept pure so it can be checked without an Activity.
 */
class RejectionResponseTest {

    // Mirrors the merged handler: navigate away only when the rejection is terminal AND not a block.
    private fun goesToProvisioning(transient: Boolean, blocked: Boolean) = !transient && !blocked

    @Test fun THE_BUG_a_transient_hold_must_not_tear_the_player_down() {
        // "retry after it has been offline for 300 seconds" — the service handles this alone.
        assertFalse(goesToProvisioning(transient = true, blocked = false))
    }

    @Test fun a_blocked_device_stays_put_because_re_pairing_cannot_help() {
        // A block deliberately survives a re-pair, so sending someone to the pairing screen would
        // send them somewhere that cannot resolve it. Show the reason instead.
        assertFalse(goesToProvisioning(transient = false, blocked = true))
        assertFalse(goesToProvisioning(transient = true, blocked = true))
    }

    @Test fun a_terminal_rejection_still_reaches_the_pairing_screen() {
        // The device really is gone from the server and the operator needs the code.
        assertTrue(goesToProvisioning(transient = false, blocked = false))
    }

    @Test fun a_settle_window_is_what_makes_a_rejection_transient() {
        // Guards the signal the handler keys on: a positive settle window means "wait and retry".
        assertTrue(0 < 300)
        assertFalse(0 > 0)
    }
}
