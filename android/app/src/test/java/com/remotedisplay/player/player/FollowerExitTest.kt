package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Leaving follower mode (video wall follower, or group sync) has to re-arm self-advance.
 *
 * While follower mode is on, playCurrentItem() never calls scheduleAdvance() — the wall/group tick
 * owns the index. So clearing the flag is not enough: the item on screen has NOTHING scheduled to
 * move it. Unchecking "sync" on a group left every member showing an image frozen on one frame
 * until the app was restarted, which is exactly what a 30-frame sample of a real panel showed —
 * one unique frame, indefinitely.
 */
class FollowerExitTest {

    private val TEN_SEC = 10_000L

    @Test fun THE_BUG_an_image_mid_slot_gets_the_remaining_time() {
        // 8s into a 10s image: advance in ~2s, don't restart the whole slot.
        assertEquals(2_000L, FollowerExit.resumeDelayMs(
            isRunning = true, isImageOrWidget = true, slotMs = TEN_SEC, elapsedMs = 8_000L))
    }

    @Test fun THE_BUG_an_image_whose_slot_already_elapsed_advances_immediately() {
        // The freeze case: sync held this item well past its duration. 0 is honest; the caller's
        // MIN_ADVANCE_MS backstop keeps it off a busy loop.
        assertEquals(0L, FollowerExit.resumeDelayMs(
            isRunning = true, isImageOrWidget = true, slotMs = TEN_SEC, elapsedMs = 45_000L))
    }

    @Test fun a_freshly_started_image_gets_its_full_slot() {
        assertEquals(TEN_SEC, FollowerExit.resumeDelayMs(
            isRunning = true, isImageOrWidget = true, slotMs = TEN_SEC, elapsedMs = 0L))
    }

    @Test fun a_widget_is_time_driven_like_an_image() {
        assertEquals(3_000L, FollowerExit.resumeDelayMs(
            isRunning = true, isImageOrWidget = true, slotMs = TEN_SEC, elapsedMs = 7_000L))
    }

    @Test fun video_is_left_alone_because_it_advances_on_completion() {
        // onVideoComplete() -> next() already handles this, and arming a timer would cut the clip.
        assertNull(FollowerExit.resumeDelayMs(
            isRunning = true, isImageOrWidget = false, slotMs = TEN_SEC, elapsedMs = 8_000L))
    }

    @Test fun nothing_is_armed_when_the_playlist_is_not_running() {
        // playCurrentItem() will arm it when playback actually starts.
        assertNull(FollowerExit.resumeDelayMs(
            isRunning = false, isImageOrWidget = true, slotMs = TEN_SEC, elapsedMs = 1_000L))
    }

    @Test fun the_delay_is_never_negative() {
        for (elapsed in listOf(10_001L, 60_000L, Long.MAX_VALUE / 2)) {
            val d = FollowerExit.resumeDelayMs(true, true, TEN_SEC, elapsed)!!
            assert(d >= 0L) { "delay must never be negative, got $d for elapsed=$elapsed" }
        }
    }
}
