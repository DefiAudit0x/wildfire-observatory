package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.16.0 (audit wave 3) — absolute-URL host allowlist + principal-cookie
 * scoping contract. The API client must never open a socket to a host the
 * app did not explicitly choose, and the identity cookie must never leave
 * the observatory origin.
 */
class ObservatoryApiTargetTest {

    private val api = ObservatoryApi("https://wildfire-observatory.onrender.com")

    // ---------- resolveTarget ----------

    @Test
    fun `relative path gets the base prefix`() {
        assertEquals(
            "https://wildfire-observatory.onrender.com/api/reports",
            api.resolveTarget("/api/reports")
        )
    }

    @Test
    fun `same-host absolute url is normalized not doubled`() {
        assertEquals(
            "https://wildfire-observatory.onrender.com/api/reports",
            api.resolveTarget("https://wildfire-observatory.onrender.com/api/reports")
        )
    }

    @Test
    fun `allowlisted external host over https is admitted`() {
        val osrm = "https://router.project-osrm.org/route/v1/driving/1,2;3,4"
        assertEquals(osrm, api.resolveTarget(osrm))
        val meteo = "https://api.open-meteo.com/v1/forecast?latitude=1"
        assertEquals(meteo, api.resolveTarget(meteo))
    }

    @Test
    fun `external host over plaintext http is refused`() {
        assertNull(api.resolveTarget("http://api.open-meteo.com/v1/forecast"))
        assertNull(api.resolveTarget("http://router.project-osrm.org/route/v1/driving/1,2;3,4"))
    }

    @Test
    fun `unknown host is refused closed`() {
        assertNull(api.resolveTarget("https://evil.example.com/collect"))
        // A lookalike domain must not pass a suffix/substring match.
        assertNull(api.resolveTarget("https://api.open-meteo.com.evil.example.com/v1"))
        assertNull(api.resolveTarget("https://notopen-meteo.com/v1"))
    }

    @Test
    fun `garbage url is refused not thrown`() {
        assertNull(api.resolveTarget("https://"))
        assertNull(api.resolveTarget("http:// "))
    }

    // ---------- sendsPrincipalCookie ----------

    @Test
    fun `principal cookie rides only same-host requests`() {
        assertTrue(api.sendsPrincipalCookie("https://wildfire-observatory.onrender.com/api/teams/join"))
        assertTrue(api.sendsPrincipalCookie("/api/teams/join"))
        assertFalse(api.sendsPrincipalCookie("https://router.project-osrm.org/route/v1/driving/1,2;3,4"))
        assertFalse(api.sendsPrincipalCookie("https://api.open-meteo.com/v1/forecast"))
    }

    @Test
    fun `principal cookie stays home on a different scheme or port`() {
        // Origin, not host: the same hostname over plaintext http, or on a
        // different port, is a different origin — the identity cookie must
        // never ride it. (The old host-only comparison leaked both ways.)
        assertFalse(api.sendsPrincipalCookie("http://wildfire-observatory.onrender.com/api/teams/join"))
        assertFalse(api.sendsPrincipalCookie("https://wildfire-observatory.onrender.com:8443/api/teams/join"))
        assertFalse(api.sendsPrincipalCookie("http://wildfire-observatory.onrender.com:80/api/teams/join"))
        // The explicit default port IS the same origin.
        assertTrue(api.sendsPrincipalCookie("https://wildfire-observatory.onrender.com:443/api/teams/join"))
    }

    @Test
    fun `cookie is never sent when the host cannot be parsed`() {
        val broken = ObservatoryApi("https://wildfire-observatory.onrender.com")
        assertFalse(broken.sendsPrincipalCookie("https://"))
    }

    @Test
    fun `host comparison is case insensitive`() {
        assertEquals(
            "https://API.open-meteo.com/v1",
            api.resolveTarget("https://API.open-meteo.com/v1")
        )
    }
}
