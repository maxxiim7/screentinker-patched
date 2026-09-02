package com.remotedisplay.player.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Root-2: the partial/truncated-download detection rule that keeps a broken file out of the cache. */
class CacheValidationTest {

    @Test fun `full download with known length is complete`() {
        assertTrue(CacheValidation.isComplete(bytesWritten = 100, expectedBytes = 100))
    }

    @Test fun `truncated download (fewer bytes than declared) is INCOMPLETE`() {
        assertFalse(CacheValidation.isComplete(bytesWritten = 40, expectedBytes = 100))
    }

    @Test fun `over-read (more than declared) is treated as INCOMPLETE, not promoted`() {
        assertFalse(CacheValidation.isComplete(bytesWritten = 150, expectedBytes = 100))
    }

    @Test fun `unknown length (chunked, -1) with bytes falls back to complete`() {
        assertTrue(CacheValidation.isComplete(bytesWritten = 100, expectedBytes = -1))
    }

    @Test fun `zero bytes is never complete`() {
        assertFalse(CacheValidation.isComplete(bytesWritten = 0, expectedBytes = -1))
        assertFalse(CacheValidation.isComplete(bytesWritten = 0, expectedBytes = 100))
    }
}
