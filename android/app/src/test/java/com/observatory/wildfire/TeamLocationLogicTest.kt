package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the Phase 2 team-location decision layer. Every rule
 * here is load-bearing on a life-safety channel: the allow-list decides which
 * hosts may receive the member's bearer token, the token sanity check decides
 * what may ride an Authorization header, and the verdict classifier decides
 * whether a dead session stops the stream or a bad beat is retried.
 */
class TeamLocationLogicTest {

    // ========================
    // BASE-URL ALLOW-LIST
    // ========================

    @Test
    fun `allow-list accepts production HTTPS hosts`() {
        assertTrue(TeamLocationLogic.isAllowedBaseUrl("https://wildfire-observatory-odcibw.fly.dev"))
        assertTrue(TeamLocationLogic.isAllowedBaseUrl("https://wildfire-observatory-odcibw.fly.dev/api/teams/heartbeat"))
        assertTrue(TeamLocationLogic.isAllowedBaseUrl("https://wildfire-observatory-production.up.railway.app"))
    }

    @Test
    fun `allow-list accepts local dev loopback over http or https`() {
        assertTrue(TeamLocationLogic.isAllowedBaseUrl("http://localhost:3000"))
        assertTrue(TeamLocationLogic.isAllowedBaseUrl("https://127.0.0.1/api/teams/heartbeat"))
        assertTrue(TeamLocationLogic.isAllowedBaseUrl("http://10.0.2.2:3000"))
    }

    @Test
    fun `allow-list rejects cleartext production and every foreign host`() {
        // production hosts must be HTTPS
        assertFalse(TeamLocationLogic.isAllowedBaseUrl("http://wildfire-observatory-odcibw.fly.dev"))
        assertFalse(TeamLocationLogic.isAllowedBaseUrl("http://wildfire-observatory-production.up.railway.app"))
        // lookalikes: substring and userinfo tricks must never pass
        assertFalse(TeamLocationLogic.isAllowedBaseUrl("https://evil-wildfire-observatory-odcibw.fly.dev.example.com"))
        assertFalse(TeamLocationLogic.isAllowedBaseUrl("https://localhost.evil.com"))
        assertFalse(TeamLocationLogic.isAllowedBaseUrl("https://localhost@evil.com"))
        assertFalse(TeamLocationLogic.isAllowedBaseUrl("ftp://localhost"))
        assertFalse(TeamLocationLogic.isAllowedBaseUrl("file:///etc/passwd"))
        assertFalse(TeamLocationLogic.isAllowedBaseUrl(""))
        assertFalse(TeamLocationLogic.isAllowedBaseUrl("not a url"))
    }

    // ========================
    // INPUT SANITY
    // ========================

    @Test
    fun `member and team id shapes match the server contract`() {
        assertTrue(TeamLocationLogic.isValidMemberId("tm-0123456789abcdef"))
        assertFalse(TeamLocationLogic.isValidMemberId("tm-XYZ"))
        assertFalse(TeamLocationLogic.isValidMemberId("tm-0123456789abcdeg")) // g is not hex
        assertFalse(TeamLocationLogic.isValidMemberId(""))
        assertTrue(TeamLocationLogic.isValidTeamId("team-a1"))
        assertTrue(TeamLocationLogic.isValidTeamId("team-0123abcd"))
        assertFalse(TeamLocationLogic.isValidTeamId("../etc"))
        assertFalse(TeamLocationLogic.isValidTeamId("ab"))
    }

    @Test
    fun `token sanity blocks header injection and control characters`() {
        assertTrue(TeamLocationLogic.isSaneToken("eyJhbGciOiJIUzI1NiJ9.eyJzY29wZSI6InRlYW0tbWVtYmVyIn0.c0ignL8V0Xn8"))
        // CRLF injection attempt
        assertFalse(TeamLocationLogic.isSaneToken("goodtoken\r\nX-Steal: 1"))
        assertFalse(TeamLocationLogic.isSaneToken("good token"))
        assertFalse(TeamLocationLogic.isSaneToken("short"))
        assertFalse(TeamLocationLogic.isSaneToken(""))
        // non-ASCII garbage
        assertFalse(TeamLocationLogic.isSaneToken("tokentokenﬁtoken-token"))
    }

    @Test
    fun `interval clamps into the 10s-60s window`() {
        assertEquals(15_000L, TeamLocationLogic.clampIntervalMs(15_000L))
        assertEquals(10_000L, TeamLocationLogic.clampIntervalMs(3_000L))
        assertEquals(60_000L, TeamLocationLogic.clampIntervalMs(120_000L))
        assertEquals(10_000L, TeamLocationLogic.clampIntervalMs(0L))
    }

    // ========================
    // HEARTBEAT BODY
    // ========================

    @Test
    fun `body includes every present field and omits absent ones`() {
        assertEquals(
            "{\"lat\":36.75,\"lng\":5.07,\"accuracy\":8.0,\"heading\":90.0,\"speed\":4.5,\"batteryPct\":77}",
            TeamLocationLogic.buildHeartbeatBodyJson(36.75, 5.07, 8.0, 90.0, 4.5, 77)
        )
        assertEquals(
            "{\"lat\":36.75,\"lng\":5.07}",
            TeamLocationLogic.buildHeartbeatBodyJson(36.75, 5.07, null, null, null, null)
        )
    }

    @Test
    fun `non-finite coordinates degrade to null instead of corrupting the JSON`() {
        // JSON has no NaN — a broken fix must not 400 the whole beat forever.
        assertEquals(
            "{\"lat\":null,\"lng\":5.07}",
            TeamLocationLogic.buildHeartbeatBodyJson(Double.NaN, 5.07, null, null, null, null)
        )
        // never-CI-tested typo caught by the first real gradle run: an
        // Infinity lng degrades to null (the doctrine), not to 5.07
        assertEquals(
            "{\"lat\":36.75,\"lng\":null}",
            TeamLocationLogic.buildHeartbeatBodyJson(36.75, Double.POSITIVE_INFINITY, null, null, null, null)
        )
        // out-of-range battery is dropped, not sent
        assertEquals(
            "{\"lat\":36.75,\"lng\":5.07}",
            TeamLocationLogic.buildHeartbeatBodyJson(36.75, 5.07, null, null, null, 250)
        )
    }

    // ========================
    // SERVER VERDICT CLASSIFICATION
    // ========================

    @Test
    fun `2xx is OK, retry-class statuses stay retry`() {
        assertEquals(TeamLocationLogic.Verdict.OK, TeamLocationLogic.classifyVerdict(200, "{\"ok\":true}"))
        assertEquals(TeamLocationLogic.Verdict.OK, TeamLocationLogic.classifyVerdict(201, "{}"))
        assertEquals(TeamLocationLogic.Verdict.RETRY, TeamLocationLogic.classifyVerdict(400, "{\"error\":\"out of coverage\"}"))
        assertEquals(TeamLocationLogic.Verdict.RETRY, TeamLocationLogic.classifyVerdict(429, "{\"error\":\"too frequent\"}"))
        assertEquals(TeamLocationLogic.Verdict.RETRY, TeamLocationLogic.classifyVerdict(503, "{\"code\":\"TEAMS_STORAGE_UNAVAILABLE\"}"))
    }

    @Test
    fun `redirect statuses are retry-class (F8 pin makes them surface raw)`() {
        // With instanceFollowRedirects=false (S2), a 30x is never silently
        // chased to another host — it surfaces as its status, and the doctrine
        // verdict for "not 2xx/401/403" is RETRY, never a session death.
        assertEquals(TeamLocationLogic.Verdict.RETRY, TeamLocationLogic.classifyVerdict(301, ""))
        assertEquals(TeamLocationLogic.Verdict.RETRY, TeamLocationLogic.classifyVerdict(302, ""))
        assertEquals(TeamLocationLogic.Verdict.RETRY, TeamLocationLogic.classifyVerdict(307, "{\"mission\":{}}"))
        assertEquals(TeamLocationLogic.Verdict.RETRY, TeamLocationLogic.classifyVerdict(308, ""))
    }

    @Test
    fun `403 gate codes map to their precise fatal verdicts`() {
        assertEquals(
            TeamLocationLogic.Verdict.FATAL_REVOKED,
            TeamLocationLogic.classifyVerdict(403, "{\"code\":\"MEMBER_REVOKED\",\"error\":\"revoked\"}")
        )
        assertEquals(
            TeamLocationLogic.Verdict.FATAL_MEMBER,
            TeamLocationLogic.classifyVerdict(403, "{\"code\":\"MEMBER_INACTIVE\",\"error\":\"deactivated\"}")
        )
        assertEquals(
            TeamLocationLogic.Verdict.FATAL_MEMBER,
            TeamLocationLogic.classifyVerdict(403, "{\"code\":\"MEMBER_INVALID\",\"error\":\"missing\"}")
        )
        assertEquals(
            TeamLocationLogic.Verdict.FATAL_TEAM,
            TeamLocationLogic.classifyVerdict(403, "{\"code\":\"TEAM_INACTIVE\",\"error\":\"team dead\"}")
        )
        assertEquals(
            TeamLocationLogic.Verdict.FATAL_AUTH,
            TeamLocationLogic.classifyVerdict(403, "{}")
        )
        assertEquals(TeamLocationLogic.Verdict.FATAL_AUTH, TeamLocationLogic.classifyVerdict(401, "{}"))
    }

    // ========================
    // SERVER-PACED INTERVAL
    // ========================

    @Test
    fun `heartbeat interval is parsed and clamped, garbage falls back to 15s`() {
        assertEquals(30_000L, TeamLocationLogic.parseHeartbeatIntervalMs("{\"ok\":true,\"serverTime\":1,\"heartbeatIntervalMs\":30000,\"mission\":null}"))
        assertEquals(15_000L, TeamLocationLogic.parseHeartbeatIntervalMs("{\"ok\":true}"))
        assertEquals(15_000L, TeamLocationLogic.parseHeartbeatIntervalMs("not json"))
        assertEquals(10_000L, TeamLocationLogic.parseHeartbeatIntervalMs("{\"heartbeatIntervalMs\":3000}"))
        assertEquals(60_000L, TeamLocationLogic.parseHeartbeatIntervalMs("{\"heartbeatIntervalMs\":999999}"))
    }

    // ========================
    // MISSION EXTRACTION (F3 — native beat → panel mission channel)
    // ========================

    @Test
    fun `mission object is extracted verbatim from a heartbeat body`() {
        val body = "{\"ok\":true,\"serverTime\":1,\"heartbeatIntervalMs\":15000," +
            "\"mission\":{\"sosId\":\"sos-9\",\"phase\":\"en_route\",\"since\":42}}"
        assertEquals(
            "{\"sosId\":\"sos-9\",\"phase\":\"en_route\",\"since\":42}",
            TeamLocationLogic.extractMissionJson(body)
        )
    }

    @Test
    fun `mission null, absent mission and non-JSON bodies yield null`() {
        assertNull(TeamLocationLogic.extractMissionJson("{\"ok\":true,\"mission\":null}"))
        assertNull(TeamLocationLogic.extractMissionJson("{\"ok\":true,\"serverTime\":1}"))
        assertNull(TeamLocationLogic.extractMissionJson("not json"))
        assertNull(TeamLocationLogic.extractMissionJson(""))
        // a string (non-object) mission value is not extractable — panel keeps state
        assertNull(TeamLocationLogic.extractMissionJson("{\"mission\":\"weird\"}"))
    }

    @Test
    fun `mission extraction survives braces inside strings and nested objects`() {
        assertEquals(
            "{\"sosId\":\"a}b\",\"note\":\"x{y\"}",
            TeamLocationLogic.extractMissionJson("{\"mission\":{\"sosId\":\"a}b\",\"note\":\"x{y\"},\"ok\":true}")
        )
        assertEquals(
            "{\"sosId\":\"sos-1\",\"meta\":{\"nested\":{\"deep\":2}}}",
            TeamLocationLogic.extractMissionJson("{\"mission\":{\"sosId\":\"sos-1\",\"meta\":{\"nested\":{\"deep\":2}}},\"ok\":true}")
        )
        // unterminated object → no balanced close → null (bounded scan)
        assertNull(TeamLocationLogic.extractMissionJson("{\"mission\":{\"sosId\":\"sos-1\""))
    }

    // ========================
    // PHASE 3 — ARRIVAL GEOMETRY (haversine, streak, target parsing, flip body)
    // ========================

    @Test
    fun `haversine matches known distances`() {
        // Same point → zero
        assertEquals(0.0, TeamLocationLogic.haversineMeters(36.75, 5.07, 36.75, 5.07), 1e-9)
        // One degree of latitude ≈ 111.19 km
        val perDegree = TeamLocationLogic.haversineMeters(36.0, 5.07, 37.0, 5.07)
        assertEquals(111_190.0, perDegree, 200.0)
        // Symmetry
        assertEquals(
            TeamLocationLogic.haversineMeters(36.75, 5.07, 36.7601, 5.07),
            TeamLocationLogic.haversineMeters(36.7601, 5.07, 36.75, 5.07),
            1e-6
        )
    }

    @Test
    fun `arrival streak counts consecutive in-range fixes and fully resets on one miss`() {
        assertEquals(TeamLocationLogic.ARRIVAL_RADIUS_M, 50.0, 1e-9)
        assertEquals(TeamLocationLogic.ARRIVAL_STREAK_NEEDED, 2)
        var s = 0
        s = TeamLocationLogic.nextArrivalStreak(s, 49.9)
        assertEquals(1, s)
        s = TeamLocationLogic.nextArrivalStreak(s, 0.0)
        assertEquals(2, s)
        assertTrue(TeamLocationLogic.shouldAutoArrive(s))
        // boundary: exactly at the radius counts as in range
        s = TeamLocationLogic.nextArrivalStreak(0, 50.0)
        assertEquals(1, s)
        // one stray jump → full reset, not a decrement
        s = TeamLocationLogic.nextArrivalStreak(s, 50.1)
        assertEquals(0, s)
        assertFalse(TeamLocationLogic.shouldAutoArrive(0))
        assertFalse(TeamLocationLogic.shouldAutoArrive(1))
    }

    @Test
    fun `mission target coords parse from the extracted mission object`() {
        val mission = "\"sosId\":\"sos-9\",\"phase\":\"en_route\",\"since\":42,\"sosLat\":36.7503,\"sosLng\":5.0703"
        val target = TeamLocationLogic.parseMissionCoords(mission)
        assertNotNull(target)
        assertEquals(36.7503, target!!.first, 1e-9)
        assertEquals(5.0703, target.second, 1e-9)
        assertEquals("sos-9", TeamLocationLogic.parseMissionSosId(mission))
        assertEquals("en_route", TeamLocationLogic.parseMissionPhase(mission))
    }

    @Test
    fun `missing or garbage target coords yield null (never 0,0)`() {
        // Legacy mission without coordinates
        assertNull(TeamLocationLogic.parseMissionCoords("\"sosId\":\"sos-9\",\"phase\":\"en_route\",\"since\":42"))
        assertNull(TeamLocationLogic.parseMissionCoords(null))
        assertNull(TeamLocationLogic.parseMissionCoords(""))
        // Garbage coordinates — a string value is not a number token
        assertNull(TeamLocationLogic.parseMissionCoords("\"sosLat\":\"abc\",\"sosLng\":5.07"))
        // Negative coordinates are legitimate (western longitudes)
        val west = TeamLocationLogic.parseMissionCoords("\"sosLat\":35.1,\"sosLng\":-6.2")
        assertEquals(-6.2, west?.second!!, 1e-9)
        // Null/blank ids and phases
        assertNull(TeamLocationLogic.parseMissionSosId(null))
        assertNull(TeamLocationLogic.parseMissionPhase("\"sosId\":\"sos-9\""))
    }

    @Test
    fun `phase flip body carries the phase and the evidence fix`() {
        assertEquals(
            "{\"phase\":\"on_scene\",\"lat\":36.7503,\"lng\":5.0703,\"accuracy\":8.0}",
            TeamLocationLogic.buildPhaseFlipBodyJson(36.7503, 5.0703, 8.0)
        )
        assertEquals(
            "{\"phase\":\"on_scene\",\"lat\":36.7503,\"lng\":5.0703}",
            TeamLocationLogic.buildPhaseFlipBodyJson(36.7503, 5.0703, null)
        )
        // Non-finite evidence degrades to null — the zod gate will refuse it
        assertEquals(
            "{\"phase\":\"on_scene\",\"lat\":null,\"lng\":5.0703}",
            TeamLocationLogic.buildPhaseFlipBodyJson(Double.NaN, 5.0703, 8.0)
        )
    }

    @Test
    fun `mission key identifies one dispatch leg — fresh since re-arms arrival`() {
        val leg1 = "\"sosId\":\"sos-9\",\"phase\":\"en_route\",\"since\":1000"
        val leg2 = "\"sosId\":\"sos-9\",\"phase\":\"en_route\",\"since\":2000"
        assertEquals("sos-9:1000", TeamLocationLogic.missionKey(leg1))
        assertEquals("sos-9:2000", TeamLocationLogic.missionKey(leg2))
        // different sos → different key even with equal since
        assertEquals(
            "sos-OTHER:1000",
            TeamLocationLogic.missionKey("\"sosId\":\"sos-OTHER\",\"phase\":\"en_route\",\"since\":1000")
        )
        // missing since degrades to a stable 0 (legacy mission)
        assertEquals("sos-9:0", TeamLocationLogic.missionKey("\"sosId\":\"sos-9\",\"phase\":\"en_route\""))
        assertEquals(0L, TeamLocationLogic.parseMissionSince(null))
        assertNull(TeamLocationLogic.missionKey(null))
        assertNull(TeamLocationLogic.missionKey("\"since\":1000"))
    }
}
