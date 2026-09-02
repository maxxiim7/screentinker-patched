package com.remotedisplay.player.service

import android.content.Context
import com.remotedisplay.player.data.ServerConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Exit-signal contract v1 — best-effort "last gasp" (manner of death), APK conformance.
 *
 * Sent via a BLOCKING OkHttp POST to /api/device/exit, NOT socket.emit: the socket emit path is
 * async with no flush, so it will not reliably leave the buffer before the process dies. A short,
 * bounded blocking POST from the crashing thread (about to die anyway) / a worker thread is the
 * reliable transport on Android (matches the beacon the browser/Tizen clients use).
 *
 * Categories (honesty by construction — only ever these two; anything else -> server infers 'silent'):
 *   - "crashed"    : the global uncaught-exception handler fired (RemoteDisplayApp).
 *   - "clean_exit" : Service.onDestroy on COOPERATIVE teardown (stopService/unbind/memory-reclaim-with-
 *                    grace). NOT onStop/onPause (those fire on backgrounding). force-stop / MDM-uninstall
 *                    / SIGKILL / OOM skip all callbacks -> nothing is sent -> server infers 'silent'.
 * Idempotent: the first confident signal wins (a crash is never relabelled clean_exit).
 */
object ExitSignal {
    @Volatile private var sent = false
    private val JSON = "application/json".toMediaType()
    private val client = OkHttpClient.Builder()
        .callTimeout(2, TimeUnit.SECONDS)
        .connectTimeout(2, TimeUnit.SECONDS)
        .writeTimeout(2, TimeUnit.SECONDS)
        .build()

    fun send(context: Context, reason: String, detail: String?) {
        try {
            if (sent) return
            if (reason != "crashed" && reason != "clean_exit") return
            val cfg = ServerConfig(context.applicationContext)
            val id = cfg.deviceId
            val token = cfg.deviceToken
            val url = cfg.serverUrl
            if (id.isEmpty() || token.isEmpty() || url.isEmpty()) return   // unpaired -> nothing to attribute
            sent = true
            val payload = JSONObject().apply {
                put("device_id", id)
                put("device_token", token)
                put("reason", reason)
                if (!detail.isNullOrBlank()) put("detail", detail.take(200))
            }.toString()
            val req = Request.Builder()
                .url(url.trimEnd('/') + "/api/device/exit")
                .post(payload.toRequestBody(JSON))
                .build()
            client.newCall(req).execute().use { /* fire-and-forget; response ignored */ }
        } catch (t: Throwable) {
            /* a dying process must never throw further out of the last gasp */
        }
    }
}
