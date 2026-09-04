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
        const val USER_AGENT = "WildfireObservatory-Android/2.17.0"
        private const val MAX_RESPONSE_BYTES = 32 * 1024
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 10_000
        const val PRINCIPAL_COOKIE_NAME = "public_principal"

        /**
         * v2.16.0 (audit wave 3 — host allowlist for absolute URLs): the ONLY
         * third-party hosts an absolute URL handed to this API may target.
         * Nominatim reverse-geocoding rides the server's /api/geo/reverse
         * proxy; FIRMS rides the server proxy + the Cloudflare worker — the
         * two survivors are the OSRM router and the Open-Meteo forecast,
         * both built by ApiPayloads. Anything else (a URL echoed back by a
         * server response, a crafted report field, a future mistake) is
         * refused closed before a socket exists.
         */
        val EXTERNAL_HOSTS = setOf(
            "router.project-osrm.org",
            "api.open-meteo.com"
        )
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

    /**
     * v2.16.0 (audit wave 3 — host allowlist): resolve the request target
     * for [path]. Pure and unit-testable.
     *
     *  - API paths arrive relative and get the base prefix;
     *  - a full URL that already starts with the base is normalized, never
     *    doubled (same-host absolute URLs are allowed);
     *  - external services arrive as absolute URLs and are admitted ONLY
     *    when their host is in [EXTERNAL_HOSTS] AND the scheme is https —
     *    any other host is refused (null) before a socket exists, so a
     *    URL echoed back from a server response or crafted report field
     *    can never turn this client into an exfiltration channel.
     */
    fun resolveTarget(path: String): String? {
        val target = when {
            path.startsWith("http://") || path.startsWith("https://") -> path
            else -> baseUrl + path
        }
        val host = hostOf(target) ?: return null
        if (!hostOf(baseUrl).isNullOrEmpty() && host == hostOf(baseUrl)) return target
        return if (host in EXTERNAL_HOSTS && target.startsWith("https://")) target else null
    }

    /**
     * v2.16.0 (audit wave 3 — cookie scoping): the principal cookie is
     * identity for the OBSERVATORY server. It must never ride a request to
     * a third-party host (OSRM/Open-Meteo do not need it; a future bug that
     * routed an absolute URL off-base must not leak it). Pure; tested.
     *
     * Relative paths are same-origin BY CONSTRUCTION (resolveTarget prefixes
     * the base) — allowed. Absolute URLs: allowed only when the parsed host
     * equals the base host; an unparsable absolute URL is refused.
     */
    fun sendsPrincipalCookie(target: String): Boolean {
        val base = hostOf(baseUrl) ?: return false
        if (target.startsWith("http://") || target.startsWith("https://")) {
            val host = hostOf(target) ?: return false
            return host == base
        }
        return true
    }

    private fun hostOf(url: String): String? = try {
        java.net.URI(url).host?.lowercase()
    } catch (e: Exception) {
        null
    }

    private fun request(method: String, path: String, bodyJson: String?, cookie: String?): Result {
        // v2.16.0: the allowlist decides before any socket is opened. A
        // disallowed target is a TransportFailure — callers already treat
        // that as "queue it and retry later", which is the honest outcome
        // for a request we refuse to make.
        val target = resolveTarget(path) ?: return Result.TransportFailure
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
            if (cookie != null && sendsPrincipalCookie(target)) {
                http.setRequestProperty("Cookie", cookie)
            }
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
