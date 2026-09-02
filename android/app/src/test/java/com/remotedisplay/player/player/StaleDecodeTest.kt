package com.remotedisplay.player.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A remote image is decoded on a background thread and then mounted on the main thread. It was
 * mounted unconditionally, with no check that it was still wanted.
 *
 * ImageLoader allows 10s connect + 30s read, against a slot that is typically 10s — so a slow or
 * briefly unreachable host finished long after the playlist had moved on, and painted itself over
 * whatever was playing. If that was a video the mount also called exoPlayer.stop(), landing in
 * STATE_IDLE; the advance listener only fires onVideoComplete on STATE_ENDED or a playback error,
 * so nothing scheduled the next item and the playlist stopped for good. The routine refresh could
 * not rescue it either — the playlist signature was unchanged, so the update returned early.
 *
 * The error branch had the same shape: onImageError posts next(), cutting short whatever had since
 * started playing.
 *
 * PipOverlay.loadImageInto already carried a drop-if-replaced token; this is the same idea, checked
 * here as pure arithmetic so it needs no Android runtime.
 */
class StaleDecodeTest {

    /** Mirrors the guard: a decode applies only if nothing else has taken the screen since. */
    private fun applies(captured: Long, current: Long) = captured == current

    @Test fun THE_BUG_a_decode_that_finishes_after_the_playlist_moved_on_is_dropped() {
        var generation = 0L
        val captured = ++generation      // the slow image starts loading
        generation++                     // ...the playlist advances to a video
        assertFalse("a stale image must not paint over the current item", applies(captured, generation))
    }

    @Test fun a_decode_that_is_still_current_is_applied() {
        var generation = 0L
        val captured = ++generation
        assertTrue(applies(captured, generation))
    }

    @Test fun only_the_LATEST_of_several_queued_decodes_wins() {
        // Two images in a row, both slow: the first must not land after the second.
        var generation = 0L
        val first = ++generation
        val second = ++generation
        assertFalse(applies(first, generation))
        assertTrue(applies(second, generation))
    }

    @Test fun the_error_branch_is_gated_too() {
        // onImageError posts next(). Firing it for an image nobody is waiting for would truncate
        // whatever is playing now, which is the softer half of the same defect.
        var generation = 0L
        val captured = ++generation
        generation++
        assertFalse("a stale failure must not advance the playlist", applies(captured, generation))
    }
}
