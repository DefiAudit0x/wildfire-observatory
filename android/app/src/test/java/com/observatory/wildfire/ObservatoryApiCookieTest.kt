package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Phase C (principal-cookie ghosts) — the pure Set-Cookie parser that lets
 * the native app keep ONE principal identity across rejoins. Without it the
 * bare HttpURLConnection had no cookie jar: every rejoin after process death
 * minted a fresh principal = a ghost duplicate team member on the server.
 */
class ObservatoryApiCookieTest {

    private val api = ObservatoryApi("https://example.org")

    @Test
    fun `extracts the principal cookie from a Set-Cookie header`() {
        val value = api.extractPrincipalCookie(
            listOf("public_principal=eyJhbGciOiJFUzI1NiJ9.payload.sig; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000")
        )
        assertEquals("eyJhbGciOiJFUzI1NiJ9.payload.sig", value)
    }

    @Test
    fun `finds the principal cookie among several headers`() {
        val value = api.extractPrincipalCookie(
            listOf(
                "other_cookie=not-mine; Path=/",
                "public_principal=abc.def.ghi; HttpOnly",
            )
        )
        assertEquals("abc.def.ghi", value)
    }

    @Test
    fun `returns null when the server sent no principal cookie`() {
        assertNull(api.extractPrincipalCookie(listOf("other_cookie=x; Path=/")))
        assertNull(api.extractPrincipalCookie(emptyList()))
    }

    @Test
    fun `returns null for an empty or malformed principal value`() {
        assertNull(api.extractPrincipalCookie(listOf("public_principal=; Path=/")))
        assertNull(api.extractPrincipalCookie(listOf("public_principal")))
    }

    @Test
    fun `cookie name match is exact, not a prefix`() {
        assertNull(api.extractPrincipalCookie(listOf("public_principal_v2=abc; Path=/")))
    }
}
