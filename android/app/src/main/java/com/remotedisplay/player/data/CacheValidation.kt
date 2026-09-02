package com.remotedisplay.player.data

/**
 * Root-2 caching fix — the pure, unit-testable "is this download complete?" rule (no Android deps,
 * same pattern as ConnectionGuard / OtaThrottle). [ContentCache] is the imperative shell (OkHttp +
 * filesystem); this owns the integrity decision so a truncated/partial body is never promoted to
 * the cache dir and later served as if it were a whole file (which previously wedged playback on a
 * corrupt asset with no error path).
 */
object CacheValidation {
    /**
     * Complete iff we wrote at least one byte AND — when the server declared a Content-Length
     * ([expectedBytes] > 0) — we wrote exactly that many. A truncated body
     * (bytesWritten < expectedBytes) is INCOMPLETE and must be discarded + re-fetched. When the
     * length is unknown (chunked / -1), fall back to ">0 bytes" (an interrupted copy throws and is
     * discarded upstream, so a silent zero-length truncation is the only residual gap).
     */
    fun isComplete(bytesWritten: Long, expectedBytes: Long): Boolean =
        bytesWritten > 0 && (expectedBytes <= 0 || bytesWritten == expectedBytes)
}
