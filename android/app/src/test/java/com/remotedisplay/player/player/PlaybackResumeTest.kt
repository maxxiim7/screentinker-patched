package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #234 "Android player dont play playlist properly" — with two items only one ever played.
 *
 * PlaylistController is rebuilt with every MainActivity instance, so a relaunch handed it an empty
 * list and then a full one ("0 -> N items") and it started from the top. On a panel that relaunches
 * itself at each item boundary, the second item was preempted after ~135ms every single time —
 * reproduced on an Android 9 emulator, and matching prod play_logs where the second item recorded
 * 0-1s durations while the first accumulated all the playtime. The reporter had never once seen it.
 *
 * Starting at the top is right for a genuinely cold start and wrong for a reload seconds later.
 */
class PlaybackResumeTest {

    private val NOW = 1_000_000L
    private val W = PlaybackResume.RESUME_WINDOW_MS

    @Test fun THE_BUG_a_reload_moments_after_playing_continues_where_it_was() {
        assertEquals(1, PlaybackResume.resumeIndex(
            savedIndex = 1, savedAtMs = NOW - 5_000, nowMs = NOW, itemCount = 2))
    }

    @Test fun a_genuine_cold_start_still_begins_at_the_top() {
        // Nothing saved: unchanged behaviour, which is what makes this safe to ship.
        assertEquals(0, PlaybackResume.resumeIndex(-1, 0L, NOW, 3))
    }

    @Test fun a_stale_save_is_ignored_it_is_a_cold_start_not_a_continuation() {
        assertEquals(0, PlaybackResume.resumeIndex(2, NOW - (W + 1), NOW, 3))
    }

    @Test fun just_inside_the_window_still_resumes() {
        assertEquals(2, PlaybackResume.resumeIndex(2, NOW - (W - 1), NOW, 3))
    }

    @Test fun an_index_past_the_end_falls_back_rather_than_selecting_nothing() {
        // The playlist shrank while we were away.
        assertEquals(0, PlaybackResume.resumeIndex(7, NOW - 1_000, NOW, 3))
        assertEquals(0, PlaybackResume.resumeIndex(3, NOW - 1_000, NOW, 3))
    }

    @Test fun an_empty_playlist_never_resumes() {
        assertEquals(0, PlaybackResume.resumeIndex(1, NOW - 1_000, NOW, 0))
    }

    @Test fun a_clock_that_jumped_backwards_is_treated_as_stale_not_as_fresh() {
        // Signage panels do correct their clocks. A negative age must not read as "0ms ago".
        assertEquals(0, PlaybackResume.resumeIndex(1, NOW + 60_000, NOW, 2))
    }

    @Test fun a_zero_timestamp_is_not_1970_it_is_no_save_at_all() {
        assertEquals(0, PlaybackResume.resumeIndex(1, 0L, NOW, 2))
    }

    @Test fun resuming_at_index_0_is_indistinguishable_from_starting_fresh() {
        // Deliberate: index 0 needs no special handling, and the caller treats >0 as "resume".
        assertEquals(0, PlaybackResume.resumeIndex(0, NOW - 1_000, NOW, 2))
    }
}
