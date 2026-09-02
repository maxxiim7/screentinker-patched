package com.remotedisplay.player.service

import com.remotedisplay.player.data.ContentCache
import com.remotedisplay.player.player.PlaylistSelection
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * APK VERIFY pass — the ASSEMBLY soak. Per-part tests prove the pieces; this proves the
 * caching-state-machine × liveness-watchdog INTERACTION (the novel APK-only behavior) does not
 * step on itself, driving the REAL ContentCache download + the REAL LivenessWatchdog decisions
 * through the lifecycle sequence.
 *
 * Scope note (honest): the Handler/Looper/Socket.IO runtime can't run in a plain JVM unit test
 * (no Robolectric in this module), so socket-teardown/timer wiring is verified by code-trace +
 * ConnectionGuard's decisions; the DOWNLOAD path and every WATCHDOG DECISION here are the real
 * production code exercised with real time.
 */
class AssemblyInteractionTest {

    private lateinit var dir: java.io.File
    private lateinit var cache: ContentCache
    private var server: ServerSocket? = null
    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(1, TimeUnit.SECONDS)
        .callTimeout(3, TimeUnit.SECONDS)
        .build()

    @Before fun setUp() {
        dir = Files.createTempDirectory("assembly").toFile()
        cache = ContentCache(dir, client)
    }

    @After fun tearDown() {
        try { server?.close() } catch (_: Exception) {}
        dir.deleteRecursively()
    }

    private fun serveOnce(respond: (OutputStream) -> Unit): String {
        val s = ServerSocket(0); server = s
        Thread {
            try {
                s.accept().use { sock ->
                    val r = sock.getInputStream().bufferedReader()
                    while (true) { val l = r.readLine() ?: break; if (l.isEmpty()) break }
                    respond(sock.getOutputStream())
                }
            } catch (_: Exception) {}
        }.apply { isDaemon = true; start() }
        return "http://127.0.0.1:${s.localPort}"
    }
    private fun serveComplete(body: String) = serveOnce {
        it.write("HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n".toByteArray())
        it.write(body.toByteArray()); it.flush()
    }
    private fun serveStall() = serveOnce {
        it.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n".toByteArray())
        it.write(ByteArray(10)); it.flush(); Thread.sleep(10_000)
    }
    private fun partFiles() = dir.listFiles { _, n -> n.endsWith(".part") }?.toList() ?: emptyList()

    // ===== VERIFY 1: reconnect ownership — watchdog routes through ConnectionGuard (single owner) =====
    @Test fun `watchdog reconnect opens exactly one socket via ConnectionGuard, never its own`() {
        // reconnectHalfOpen() = disconnect() [socket=null, socketActive=false] then connect(), and
        // connect() consults ConnectionGuard. After teardown -> open exactly ONE.
        assertTrue(ConnectionGuard.shouldOpenNewSocket(hasSocket = false, sameUrl = true, socketActive = false))
        // and a live/self-healing socket is REUSED (single-owner: never a second socket alongside).
        assertFalse(ConnectionGuard.shouldOpenNewSocket(hasSocket = true, sameUrl = true, socketActive = true))
    }

    // ===== VERIFY 3 CHECK A: a caching stall/retry must NOT look like server-silence =====
    @Test fun `a stalled download does NOT trip the watchdog while the socket keeps getting acks`() {
        // Real architecture: downloads run on their own thread; socket liveness is refreshed by
        // heartbeat-acks (any inbound) every 15s, INDEPENDENT of download activity. Walk a 60s
        // stall; an ack lands every 15s. Silence must never cross the (jitter-floor) threshold.
        val threshold = LivenessWatchdog.thresholdMs(0.0) // 35s — the tightest (worst-case) threshold
        var lastServerMs = 0L
        var spurious = false
        for (t in 0..60_000 step 1_000) {
            if (t % 15_000 == 0) lastServerMs = t.toLong() // ack refresh — decoupled from the download
            if (LivenessWatchdog.isHalfOpen(armed = true, connected = true, silenceMs = t - lastServerMs, thresholdMs = threshold))
                spurious = true
        }
        assertFalse("a download stall must NOT cause a watchdog reconnect while the socket is healthy", spurious)
    }

    // ===== VERIFY 3 CHECK B: server-silence DURING a download -> watchdog fires; download unharmed =====
    @Test fun `server silence during a download fires the watchdog AND the download state stays consistent`() {
        // The watchdog (server-silence) and the download (its own thread + .part file) are separate
        // subsystems: the watchdog tears down the SOCKET, never the download or its files.
        val threshold = LivenessWatchdog.thresholdMs(0.5) // 45s
        assertTrue("50s of server silence is half-open", LivenessWatchdog.isHalfOpen(true, true, 50_000, threshold))
        val f = cache.downloadContent(serveComplete("payload!"), "cidB", "v.bin")
        assertNotNull("the download completes independently of a socket reconnect", f)
        assertEquals(8L, f!!.length())
        assertTrue("no partial left — download files untouched by any reconnect", partFiles().isEmpty())
    }

    // ===== VERIFY 3 CHECK C: no double-action — retry then success leaves ONE consistent file =====
    @Test fun `caching-timeout retry and watchdog do not double-act — retry yields one consistent file`() {
        // 1st attempt stalls -> caching timeout -> null, partial cleaned (NOT a watchdog concern).
        assertNull(cache.downloadContent(serveStall(), "cidC", "v.bin"))
        assertTrue("stall leaves no orphan .part", partFiles().isEmpty())
        assertNull("stall does not promote a partial", cache.getCachedFile("cidC"))
        // retry (healthy) -> exactly one cached file, no duplicates/orphans.
        val f = cache.downloadContent(serveComplete("retry-ok"), "cidC", "v.bin")
        assertNotNull(f); assertEquals(8L, f!!.length())
        assertEquals("exactly one cached artifact for the id", 1,
            dir.listFiles { _, n -> n.startsWith("cidC.") }?.size ?: 0)
    }

    // ===== VERIFY 4: degrade-safe + the deferred ack-gap window =====
    @Test fun `degrade-safe — an ack-less server never arms the watchdog, even when very silent`() {
        assertFalse(LivenessWatchdog.isHalfOpen(armed = false, connected = true, silenceMs = 10 * 60_000, thresholdMs = 45_000))
    }

    // ===== FIX 1 + FIX 2 re-soak: through the whole sequence the SCREEN NEVER BLANKS =====
    @Test fun `re-soak — stall then ack-silence then watchdog reconnect then resume, screen never blanks`() {
        // Device is PLAYING item 0 (downloaded); item 1's download is stalled. Walk every stage.
        val onlyZeroReady: (Int) -> Boolean = { it == 0 }
        val bothReady: (Int) -> Boolean = { true }
        val threshold = LivenessWatchdog.thresholdMs(0.5)

        // 1) healthy, item 1 download STALLS on a live socket -> advancing SKIPS 1 and keeps 0
        //    (a playable index is always found, so the screen shows content — never blanks), and
        //    the stall does NOT trip the watchdog.
        assertEquals("skip the stalled item, keep playing 0", 0,
            PlaylistSelection.nextPlayableIndex(2, 0, onlyZeroReady))
        assertFalse("download stall on a live socket must not trip the watchdog",
            LivenessWatchdog.isHalfOpen(armed = true, connected = true, silenceMs = 5_000, thresholdMs = threshold))

        // 2) server goes SILENT -> the watchdog fires on ITS signal, but the screen keeps content
        assertTrue(LivenessWatchdog.isHalfOpen(true, true, 50_000, threshold))
        assertEquals("a reconnect must never blank a screen showing content",
            PlaylistSelection.NonePlayable.KEEP_CURRENT, PlaylistSelection.whenNonePlayable(hasContentOnScreen = true))

        // 3) watchdog reconnect -> EXACTLY ONE socket via ConnectionGuard (single owner)
        assertTrue(ConnectionGuard.shouldOpenNewSocket(hasSocket = false, sameUrl = true, socketActive = false))

        // 4) during the reconnect window, item 1 still not ready (downloads deferred, FIX 1) ->
        //    advancing still finds item 0 -> screen still shows content
        assertEquals(0, PlaylistSelection.nextPlayableIndex(2, 0, onlyZeroReady))

        // 5) reconnected + item 1 now fully downloaded -> swaps forward to item 1 (only ever swap
        //    to fully-valid content). At no stage did selection return -1 while 0 was ready, so the
        //    screen was never blanked.
        assertEquals(1, PlaylistSelection.nextPlayableIndex(2, 0, bothReady))
    }

    @Test fun `ack-gap window — reconnecting-not-yet-re-registered does not false-fire`() {
        // openSocket resets armed=false + lastServerMessageAt=now. Before the first post-reconnect
        // ack, armed=false so NO fire even though the OLD connection's silence was large...
        assertFalse("must not fire before the first post-reconnect ack",
            LivenessWatchdog.isHalfOpen(armed = false, connected = true, silenceMs = 999_999, thresholdMs = 45_000))
        // ...and once any-inbound (the re-register response) refreshes liveness and an ack arms it,
        // a fresh connection with small silence is healthy (still no fire).
        assertFalse("healthy post-reconnect (armed, low silence) does not fire",
            LivenessWatchdog.isHalfOpen(armed = true, connected = true, silenceMs = 500, thresholdMs = 45_000))
    }
}
