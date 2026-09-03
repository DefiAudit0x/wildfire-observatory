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
 *
 * Phase C (principal-cookie ghosts): the join endpoint now carries the
 * server's `public_principal` cookie both WAYS — sent with the request when
 * the repository has one persisted, captured from the response and returned
 * to the caller for persistence. Without it the bare HttpURLConnection had
 * NO cookie jar: every rejoin after process death minted a fresh principal
 * and therefore a GHOST duplicate team member on the server. The cookie is a
 * device pseudonym (scope=public-principal, joins nothing, authorizes
 * nothing) — disk persistence is what every browser does with it.
 */
class ObservatoryApi(private val baseUrl: String) {

    companion object {
        // F18: the UA used to hardcode "Android/2.0" while versionName moved
        // on — log triage compared mismatched versions. BuildConfig is OFF
        // (AGP 8 default), so the version is pinned here in step with the
        // release train (bump together with android/app/build.gradle).
        // (v2.11.0: the pin had drifted to 2.7.0 across the S2–S4 trains —
        // restored in step and the trains now bump it together.)
        const val USER_AGENT = "WildfireObservatory-Android/2.11.0"
        private const val MAX_RESPONSE_BYTES = 32 * 1024
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 10_000
        const val PRINCIPAL_COOKIE_NAME = "public_principal"
    }

    sealed class Result {
        data class Ok(val status: Int, val body: String, val setCookies: List<String>? = null) : Result()
        data class HttpError(val status: Int, val body: String) : Result()
        object TransportFailure : Result()

        val is2xx: Boolean get() = this is Ok
    }

    fun get(path: String): Result = request("GET", path, null, null)

    fun post(path: String, bodyJson: String, cookie: String? = null): Result = request("POST", path, bodyJson, cookie)

    /**
     * Phase C: pull the `public_principal` value out of raw Set-Cookie
     * headers. Pure and unit-testable; the server may send the cookie on
     * any join response (first issuance or sliding renewal).
     */
    fun extractPrincipalCookie(setCookies: List<String>): String? {
        for (raw in setCookies) {
            val first = raw.substringBefore(';').trim()
            val idx = first.indexOf('=')
            if (idx <= 0) continue
            if (first.substring(0, idx).trim() == PRINCIPAL_COOKIE_NAME) {
                val value = first.substring(idx + 1).trim()
                if (value.isNotEmpty()) return value
            }
        }
        return null
    }

    private fun request(method: String, path: String, bodyJson: String?, cookie: String?): Result {
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
            if (cookie != null) http.setRequestProperty("Cookie", cookie)
            if (bodyJson != null) {
                http.doOutput = true
                http.setRequestProperty("Content-Type", "application/json")
                OutputStreamWriter(http.outputStream, StandardCharsets.UTF_8).use {
                    it.write(bodyJson)
                }
            }
            val status = http.responseCode
            val body = readBody(http, status)
            if (status in 200..299) {
                // Capture Set-Cookie (case-insensitive per HTTP spec) so the
                // caller can persist the principal cookie — identity for the
                // NEXT join. Server-driven: only what the server sent is kept.
                val setCookies = http.headerFields?.entries
                    ?.filter { it.key.equals("Set-Cookie", ignoreCase = true) }
                    ?.flatMap { it.value }
                    ?.takeIf { it.isNotEmpty() }
                Result.Ok(status, body, setCookies)
            } else Result.HttpError(status, body)
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
