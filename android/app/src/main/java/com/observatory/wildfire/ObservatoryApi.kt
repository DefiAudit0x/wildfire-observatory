package com.observatory.wildfire

import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * v2.0.0 (native UI) — the single HTTP door for the native app.
 *
 * Deliberately HttpURLConnection (zero new dependencies, same hardened
 * pattern TeamLocationService has run since Phase 2):
 *  - 10s connect/read timeouts (a Render cold start must never hang the UI);
 *  - instanceFollowRedirects = FALSE — an allow-listed host's 30x must never
 *    carry our JSON to another host (F8/S2 doctrine);
 *  - bounded 32KB reads — every endpoint the app calls returns bounded JSON;
 *  - a descriptive User-Agent (Render logs + Nominatim policy both want one).
 *
 * Transport failures return a null result — callers decide queue-vs-error;
 * this class never throws outward.
 */
class ObservatoryApi(private val baseUrl: String) {

    companion object {
        // F18: the UA used to hardcode "Android/2.0" while versionName moved
        // on — log triage compared mismatched versions. It now reads the
        // ACTUAL build version at class-init time.
        val USER_AGENT = "WildfireObservatory-Android/${BuildConfig.VERSION_NAME}"
        private const val MAX_RESPONSE_BYTES = 32 * 1024
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 10_000
    }

    sealed class Result {
        data class Ok(val status: Int, val body: String) : Result()
        data class HttpError(val status: Int, val body: String) : Result()
        object TransportFailure : Result()

        val is2xx: Boolean get() = this is Ok
    }

    fun get(path: String): Result = request("GET", path, null)

    fun post(path: String, bodyJson: String): Result = request("POST", path, bodyJson)

    private fun request(method: String, path: String, bodyJson: String?): Result {
        // External services (Open-Meteo, OSRM, Nominatim) arrive as absolute
        // URLs; API paths arrive relative and get the base prefix. A full URL
        // that already starts with the base is normalized, never doubled.
        val target = when {
            path.startsWith("http://") || path.startsWith("https://") -> path
            else -> baseUrl + path
        }
        val http = try {
            URL(target).openConnection() as HttpURLConnection
        } catch (e: Exception) {
            return Result.TransportFailure
        }
        return try {
            http.requestMethod = method
            http.instanceFollowRedirects = false
            http.connectTimeout = CONNECT_TIMEOUT_MS
            http.readTimeout = READ_TIMEOUT_MS
            http.setRequestProperty("User-Agent", USER_AGENT)
            http.setRequestProperty("Accept", "application/json")
            if (bodyJson != null) {
                http.doOutput = true
                http.setRequestProperty("Content-Type", "application/json")
                OutputStreamWriter(http.outputStream, StandardCharsets.UTF_8).use {
                    it.write(bodyJson)
                }
            }
            val status = http.responseCode
            val body = readBody(http, status)
            if (status in 200..299) Result.Ok(status, body) else Result.HttpError(status, body)
        } catch (e: Exception) {
            Result.TransportFailure
        } finally {
            http.disconnect()
        }
    }

    private fun readBody(http: HttpURLConnection, status: Int): String {
        val stream = try {
            if (status in 200..299) http.inputStream else (http.errorStream ?: return "")
        } catch (e: Exception) {
            return ""
        }
        return try {
            val buffer = ByteArray(MAX_RESPONSE_BYTES + 1)
            var offset = 0
            while (offset < buffer.size) {
                val read = stream.read(buffer, offset, buffer.size - offset)
                if (read < 0) break
                offset += read
            }
            String(buffer, 0, minOf(offset, MAX_RESPONSE_BYTES), StandardCharsets.UTF_8)
        } catch (e: Exception) {
            ""
        } finally {
            try {
                stream.close()
            } catch (e: Exception) {
                // already closed
            }
        }
    }
}
