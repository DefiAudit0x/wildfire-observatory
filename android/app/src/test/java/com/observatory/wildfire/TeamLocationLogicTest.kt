package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals(
            "{\"lat\":36.75,\"lng\":5.07}",
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
}
