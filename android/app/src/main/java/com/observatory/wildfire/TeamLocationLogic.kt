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
     * Phase 3 — arrival doctrine (ARCHITECTURE.md §5.5): the FGS may ATTEMPT
     * an arrival flip only after TWO consecutive fixes inside the radius; the
     * server re-verifies the geometry against the mission target before
     * accepting. Mirrors ARRIVAL_RADIUS_M in server/routes/teams.ts and
     * teamSession.ts.
     */
    const val ARRIVAL_RADIUS_M = 50.0
    const val ARRIVAL_STREAK_NEEDED = 2

    /**
     * Outbound base-URL allow-list for the FGS. This is the UNION of the two
     * native trust sets (WebAppInterface.isTrustedOrigin's production host +
     * MainActivity's APP_URL host — they cover the Render deploy target)
     * plus the local-dev loopback hosts. The FGS posts the member's
     * Bearer token to `baseUrl + /api/teams/heartbeat`, so anything that is
     * not an exact match here is a hard NO — the service must never become a
     * token-exfiltration channel, no matter what a compromised WebView sends.
     *
     * 2026-09 host migration: the retired Railway/Fly hosts are deliberately
     * NOT kept here — expired-trial subdomains can be re-registered by
     * strangers on their platforms, and an exact match against a recycled
     * host would happily exfiltrate the bearer token to them.
     */
    fun isAllowedBaseUrl(url: String): Boolean {
        if (url.isBlank()) return false
        return try {
            val uri = java.net.URI(url.trim())
            val host = uri.host?.lowercase() ?: return false
            val scheme = uri.scheme?.lowercase() ?: return false
            when (host) {
                "wildfire-observatory.onrender.com" -> scheme == "https"
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

    // ========================
    // PHASE 3 — ARRIVAL GEOMETRY (pure, JVM-testable)
    // ========================

    /**
     * Great-circle distance in METERS (haversine) — the native mirror of
     * server/geo.ts's getHaversineDistance (km) and teamSession.ts's
     * distanceMeters (meters). Same R = 6371 km everywhere.
     */
    fun haversineMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2)
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    }

    /** One more link in the arrival chain — or a full reset when the fix fell out. */
    fun nextArrivalStreak(current: Int, distanceM: Double): Int =
        if (distanceM <= ARRIVAL_RADIUS_M) current + 1 else 0

    fun shouldAutoArrive(streak: Int): Boolean = streak >= ARRIVAL_STREAK_NEEDED

    /**
     * Mission target from the raw mission JSON substring the beat extractor
     * produced. Regex-based on purpose (house rule: no org.json in JVM unit
     * tests — same as parseHeartbeatIntervalMs). Null = no usable target:
     * the service must SKIP arrival logic (legacy mission / garbled coords),
     * never treat a missing coordinate as 0,0.
     */
    fun parseMissionCoords(missionJson: String?): Pair<Double, Double>? {
        if (missionJson.isNullOrBlank()) return null
        val lat = Regex("\"sosLat\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)").find(missionJson)
            ?.groupValues?.get(1)?.toDoubleOrNull() ?: return null
        val lng = Regex("\"sosLng\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)").find(missionJson)
            ?.groupValues?.get(1)?.toDoubleOrNull() ?: return null
        if (!lat.isFinite() || !lng.isFinite()) return null
        return lat to lng
    }

    fun parseMissionPhase(missionJson: String?): String? {
        if (missionJson.isNullOrBlank()) return null
        return Regex("\"phase\"\\s*:\\s*\"([a-z_]+)\"").find(missionJson)?.groupValues?.get(1)
    }

    fun parseMissionSosId(missionJson: String?): String? {
        if (missionJson.isNullOrBlank()) return null
        return Regex("\"sosId\"\\s*:\\s*\"([^\"]+)\"").find(missionJson)?.groupValues?.get(1)
    }

    /**
     * Mission `since` (ms epoch of the current dispatch leg). The service keys
     * its arrival state on "sosId:since" — a dispatcher force-clear + RE-dispatch
     * to the SAME sos mints a fresh `since`, and that must re-arm auto-arrival
     * (the member walks again) instead of staying gated by the old flip-done
     * marker. Missing since → "0" (still a stable key for a legacy mission).
     */
    fun parseMissionSince(missionJson: String?): Long {
        if (missionJson.isNullOrBlank()) return 0L
        return Regex("\"since\"\\s*:\\s*([0-9]+)").find(missionJson)?.groupValues?.get(1)?.toLongOrNull() ?: 0L
    }

    /** Composite mission key: identifies one DISPATCH LEG, not just one SOS. */
    fun missionKey(missionJson: String?): String? {
        val sosId = parseMissionSosId(missionJson) ?: return null
        return "$sosId:${parseMissionSince(missionJson)}"
    }

    /**
     * Evidence flip body: the phase AND the fix that justifies it — the
     * server re-checks this geometry (radius + coverage + live-position
     * consistency) before accepting. Non-finite doubles degrade to null and
     * then the zod gate rejects the flip outright, exactly like the beat.
     */
    fun buildPhaseFlipBodyJson(lat: Double, lng: Double, accuracy: Double?): String {
        val sb = StringBuilder(120)
        sb.append("{\"phase\":\"on_scene\",\"lat\":").append(jsonNumber(lat))
        sb.append(",\"lng\":").append(jsonNumber(lng))
        if (accuracy != null && accuracy.isFinite()) sb.append(",\"accuracy\":").append(jsonNumber(accuracy))
        sb.append('}')
        return sb.toString()
    }

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

    /**
     * F3 (A2/P2): extracts the `mission` OBJECT from a heartbeat response body
     * as a raw JSON substring, or null when the response carries no mission
     * (`"mission":null` / key absent). A brace-counting scan (string-aware) is
     * used instead of a `[^}]*` regex so braces inside string values or nested
     * objects cannot truncate the extraction; the scan is bounded by the
     * response body itself, which the service caps at 4KB.
     *
     * Trust note (S5): the string returned here is forwarded verbatim to the
     * WebView as a QUOTED JSON string inside `teamTrackingState`; the panel
     * JSON.parses it and re-normalizes it through its own field allow-list
     * (normalizeMission) — extra or hostile fields can only fail to parse,
     * never execute. This function decides NOTHING about validity; it only
     * extracts what the server sent.
     */
    fun extractMissionJson(body: String): String? {
        val keyIndex = body.indexOf("\"mission\"")
        if (keyIndex < 0) return null
        val colon = body.indexOf(':', keyIndex + "\"mission\"".length)
        if (colon < 0) return null
        var i = colon + 1
        while (i < body.length && body[i].isWhitespace()) i++
        if (i >= body.length || body[i] != '{') return null
        var depth = 0
        var inString = false
        var escaped = false
        for (j in i until body.length) {
            val c = body[j]
            if (inString) {
                when {
                    escaped -> escaped = false
                    c == '\\' -> escaped = true
                    c == '"' -> inString = false
                }
                continue
            }
            when (c) {
                '"' -> inString = true
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return body.substring(i, j + 1)
                }
            }
        }
        return null
    }
}
