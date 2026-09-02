package com.remotedisplay.player.service

/**
 * #234 follow-up: how often a device may ask the server to re-send its playlist.
 *
 * "Refresh" is not cheap. requestPlaylistRefresh() emits a full `device:register`, and the server's
 * register handler runs 7+ statements plus the whole fingerprint/identity path and rebuilds the
 * playlist payload. PlaylistController.next() was calling it on EVERY item advance, so a panel on a
 * 10-second image re-registered six times a minute, forever — and each reply pushed a full playlist
 * back down, which is what kept feeding the restart loop behind #234.
 *
 * It was also redundant: the heartbeat already refreshes every 4th beat (60s), so the periodic pull
 * this was duplicating exists either way. Throttling at the single chokepoint keeps every caller's
 * intent — recovery paths still refresh, they just cannot stack up — without having to rank them.
 *
 * Pure so the interval arithmetic is testable without a device or a socket.
 */
object RefreshThrottle {
    /** Just under the heartbeat's own 60s pull, so the two interleave instead of cancelling out. */
    const val MIN_INTERVAL_MS = 55_000L

    fun shouldRefresh(lastAtMs: Long, nowMs: Long): Boolean {
        if (lastAtMs <= 0L) return true          // never refreshed — always allow the first
        val since = nowMs - lastAtMs
        if (since < 0L) return true              // clock corrected backwards; never wedge on it
        return since >= MIN_INTERVAL_MS
    }
}
