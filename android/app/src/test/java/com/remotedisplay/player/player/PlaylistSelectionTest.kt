package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Screen-resilience (FIX 2): a pending/failed/stalled content download must NEVER blank or freeze
 * a screen that is showing content. These prove the SELECTION rules that guarantee it — unready
 * items are skipped (the player keeps looping what it has), and "nothing playable" keeps the
 * current content whenever anything is on screen.
 */
class PlaylistSelectionTest {

    // helper: items 0..n-1, `ready` are the indices whose content is downloaded/available
    private fun readyPredicate(vararg ready: Int): (Int) -> Boolean = { it in ready.toSet() }

    // ===== the KEY viewer scenario: playing item 0, item 1's download is stalled =====
    @Test fun `a stalled download of the NEXT item does not interrupt current content — it loops what it has`() {
        // playlist [0 ready, 1 NOT ready(downloading)]; currently playing 0. Advancing must SKIP 1
        // and come back to 0, so the viewer keeps seeing content (no blank, no "Downloading…").
        val idx = PlaylistSelection.nextPlayableIndex(size = 2, from = 0, isPlayable = readyPredicate(0))
        assertEquals("must skip the un-downloaded item and keep playing item 0", 0, idx)
    }

    @Test fun `once the download completes the next item is picked up on the following advance`() {
        // now item 1 is downloaded too -> advancing from 0 swaps to 1 (only fully-ready content).
        val idx = PlaylistSelection.nextPlayableIndex(size = 2, from = 0, isPlayable = readyPredicate(0, 1))
        assertEquals(1, idx)
    }

    // ===== partial-file safety: an un-ready (partial/corrupt) item is never selected =====
    @Test fun `an un-ready (partial-download) item is never chosen to play`() {
        // items [0 ready, 1 partial/not-ready, 2 ready] -> selection never returns 1.
        assertEquals(0, PlaylistSelection.firstPlayableIndex(3, readyPredicate(0, 2)))
        assertEquals(2, PlaylistSelection.nextPlayableIndex(3, 0, readyPredicate(0, 2)))
        assertEquals(0, PlaylistSelection.nextPlayableIndex(3, 2, readyPredicate(0, 2)))
    }

    // ===== nothing downloaded yet =====
    @Test fun `no item ready returns -1 (nothing to play)`() {
        assertEquals(-1, PlaylistSelection.firstPlayableIndex(3, readyPredicate()))
        assertEquals(-1, PlaylistSelection.nextPlayableIndex(3, 1, readyPredicate()))
    }

    // ===== the invariant: never blank while content is on screen =====
    @Test fun `nothing-playable KEEPS current content whenever something is on screen (never blanks)`() {
        assertEquals(PlaylistSelection.NonePlayable.KEEP_CURRENT,
            PlaylistSelection.whenNonePlayable(hasContentOnScreen = true))
    }

    @Test fun `nothing-playable shows the defined waiting state only when nothing is displayed yet`() {
        assertEquals(PlaylistSelection.NonePlayable.SHOW_WAITING,
            PlaylistSelection.whenNonePlayable(hasContentOnScreen = false))
    }

    // ===== single downloaded item loops (doesn't blank waiting for others) =====
    @Test fun `a single downloaded item loops instead of blanking`() {
        assertEquals(0, PlaylistSelection.nextPlayableIndex(1, 0, readyPredicate(0)))
    }

    // ===== the cold-start re-check: item 1 of the playlist must not be skipped =====
    //
    // Observed on the emulator: a freshly paired panel gets its playlist BEFORE the media has
    // downloaded, so start() finds nothing playable and the 3-second content re-check is what
    // actually begins playback. updatePlaylist() has already seeded currentIndex = 0, and the
    // re-check used to advance PAST it — so a 4-item playlist played 1,2,3,0 on its first pass and
    // a 2-item playlist looked like "only one of the two ever plays".

    @Test fun `a cold-start re-check begins at the seeded index instead of skipping past it`() {
        // currentIndex seeded to 0, nothing on screen yet, everything now downloaded.
        assertEquals("item 0 has never played — it must not be skipped", 0,
            PlaylistSelection.recheckIndex(4, from = 0, hasContentOnScreen = false, isPlayable = readyPredicate(0, 1, 2, 3)))
    }

    @Test fun `a re-check with content already on screen still advances past the current item`() {
        // The other half of the rule: a real position has had its turn, so we must move on.
        assertEquals(1,
            PlaylistSelection.recheckIndex(4, from = 0, hasContentOnScreen = true, isPlayable = readyPredicate(0, 1, 2, 3)))
    }

    @Test fun `a cold-start re-check still skips an item whose content is not downloaded`() {
        // Item 0 is still downloading; the panel starts on the first item it can actually show.
        assertEquals(2,
            PlaylistSelection.recheckIndex(4, from = 0, hasContentOnScreen = false, isPlayable = readyPredicate(2, 3)))
    }

    @Test fun `a cold-start re-check with no position yet starts at the top, not the last item`() {
        // currentIndex is -1 before updatePlaylist seeds it; wrapping onto the last item here would
        // start a fresh panel at the END of its playlist.
        assertEquals(0,
            PlaylistSelection.recheckIndex(3, from = -1, hasContentOnScreen = false, isPlayable = readyPredicate(0, 1, 2)))
    }

    @Test fun `a cold-start re-check returns -1 while nothing is downloaded`() {
        assertEquals(-1,
            PlaylistSelection.recheckIndex(3, from = 0, hasContentOnScreen = false, isPlayable = readyPredicate()))
    }

    @Test fun `playableFromIndex is inclusive of its start and wraps`() {
        assertEquals(1, PlaylistSelection.playableFromIndex(4, 1, readyPredicate(1, 3)))
        assertEquals(3, PlaylistSelection.playableFromIndex(4, 2, readyPredicate(1, 3)))
        assertEquals(1, PlaylistSelection.playableFromIndex(4, 3, readyPredicate(1)))  // wraps
        assertEquals(-1, PlaylistSelection.playableFromIndex(0, 0, readyPredicate(0)))
    }
}
