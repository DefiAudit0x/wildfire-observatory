package com.observatory.wildfire

/**
 * Phase 2 — pure, Android-free decision logic for the team-location FGS
 * (same house pattern as MeshWire: everything here must run on the JVM in
 * unit tests with zero android.jar involvement).
 *
 * The service is thin glue around these rules; every load-bearing verdict —
 * which hosts the FGS may talk to, which tokens may ride the Authorization
 * header, how server responses map to continue/retry/die — lives here so it
 * is testable and reviewable in one place.
 */
object TeamLocationLogic {

    const val DEFAULT_HEARTBEAT_MS = 15_000L
    const val MIN_HEARTBEAT_MS = 10_000L
    const val MAX_HEARTBEAT_MS = 60_000L

    /**
     * Outbound base-URL allow-list for the FGS. This is the UNION of the two
     * native trust sets (WebAppInterface.isTrustedOrigin's production host +
     * MainActivity's APP_URL host — they cover the Railway and Fly deploy
     * targets) plus the local-dev loopback hosts. The FGS posts the member's
     * Bearer token to `baseUrl + /api/teams/heartbeat`, so anything that is
     * not an exact match here is a hard NO — the service must never become a
     * token-exfiltration channel, no matter what a compromised WebView sends.
     */
    fun isAllowedBaseUrl(url: String): Boolean {
        if (url.isBlank()) return false
        return try {
            val uri = java.net.URI(url.trim())
            val host = uri.host?.lowercase() ?: return false
            val scheme = uri.scheme?.lowercase() ?: return false
            when (host) {
                "wildfire-observatory-odcibw.fly.dev",
                "wildfire-observatory-production.up.railway.app" -> scheme == "https"
                "localhost", "127.0.0.1", "10.0.2.2" -> scheme == "https" || scheme == "http"
                else -> false
            }
        } catch (e: Exception) {
            false
        }
    }

    /** Server paces beats via heartbeatIntervalMs; the client clamps to 10–60s. */
    fun clampIntervalMs(ms: Long): Long =
        if (ms < MIN_HEARTBEAT_MS) MIN_HEARTBEAT_MS
        else if (ms > MAX_HEARTBEAT_MS) MAX_HEARTBEAT_MS
        else ms

    private val MEMBER_ID_REGEX = Regex("^tm-[0-9a-f]{16}$")
    private val TEAM_ID_REGEX = Regex("^[A-Za-z0-9_-]{3,64}$")

    fun isValidMemberId(memberId: String): Boolean = MEMBER_ID_REGEX.matches(memberId)
    fun isValidTeamId(teamId: String): Boolean = TEAM_ID_REGEX.matches(teamId)

    /**
     * Token sanity for its ONLY use: an `Authorization: Bearer <token>` header.
     * Header injection is the threat: any whitespace/control character ends the
     * header line or smuggles a second one. A JWT is dot-separated base64url —
     * the shape check is deliberately light because the server verifies the
     * signature; what matters here is that nothing header-hostile passes.
     */
    fun isSaneToken(token: String): Boolean {
        if (token.length < 20 || token.length > 4096) return false
        if (token.contains('\r') || token.contains('\n') || token.contains(' ') || token.contains('\t')) return false
        return token.all { it.code in 0x21..0x7E }
    }

    /**
     * FGS heartbeat body. Doubles that are not finite are dropped to absent —
     * JSON has no NaN, and the server's zod gate would 400 the whole beat for
     * one broken field. Mirrors the web client's "omit optional fields" shape.
     */
    fun buildHeartbeatBodyJson(
        lat: Double,
        lng: Double,
        accuracy: Double?,
        heading: Double?,
        speed: Double?,
        batteryPct: Int?
    ): String {
        val sb = StringBuilder(160)
        sb.append("{\"lat\":").append(jsonNumber(lat))
        sb.append(",\"lng\":").append(jsonNumber(lng))
        if (accuracy != null && accuracy.isFinite()) sb.append(",\"accuracy\":").append(jsonNumber(accuracy))
        if (heading != null && heading.isFinite()) sb.append(",\"heading\":").append(jsonNumber(heading))
        if (speed != null && speed.isFinite()) sb.append(",\"speed\":").append(jsonNumber(speed))
        if (batteryPct != null && batteryPct in 0..100) sb.append(",\"batteryPct\":").append(batteryPct)
        sb.append('}')
        return sb.toString()
    }

    private fun jsonNumber(d: Double): String {
        if (!d.isFinite()) return "null"
        // Double.toString is valid JSON for finite values (incl. exponent form).
        return d.toString()
    }

    /**
     * Server-verdict classification for one beat. Mirrors the web client's
     * contract exactly: ONLY 401/403 are session verdicts; 400 (bad fix),
     * 429 (pacing) and 5xx are retry-class — the session must survive them,
     * because a needless death forces a code re-join and burns the budget.
     */
    enum class Verdict { OK, RETRY, FATAL_AUTH, FATAL_REVOKED, FATAL_MEMBER, FATAL_TEAM }

    fun classifyVerdict(httpStatus: Int, body: String): Verdict {
        if (httpStatus in 200..299) return Verdict.OK
        if (httpStatus == 401) return Verdict.FATAL_AUTH
        if (httpStatus == 403) {
            return when {
                body.contains("MEMBER_REVOKED") -> Verdict.FATAL_REVOKED
                body.contains("MEMBER_INACTIVE") || body.contains("MEMBER_INVALID") -> Verdict.FATAL_MEMBER
                body.contains("TEAM_INACTIVE") -> Verdict.FATAL_TEAM
                else -> Verdict.FATAL_AUTH
            }
        }
        return Verdict.RETRY
    }

    /**
     * Extracts heartbeatIntervalMs from a heartbeat response body and clamps
     * it. Body is small, server-controlled JSON; a regex keeps this JVM-pure
     * (no org.json in unit tests).
     */
    fun parseHeartbeatIntervalMs(body: String): Long {
        val match = Regex("\"heartbeatIntervalMs\"\\s*:\\s*([0-9]+)").find(body) ?: return DEFAULT_HEARTBEAT_MS
        return clampIntervalMs(match.groupValues[1].toLongOrNull() ?: DEFAULT_HEARTBEAT_MS)
    }
}
