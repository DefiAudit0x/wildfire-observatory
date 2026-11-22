package com.observatory.wildfire

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Fix 17 (NAPI-1) — pinning specs for the bounded body read. The old
 * read silently truncated any response over 32 KB and returned the
 * prefix as a success; truncated JSON then wiped last-good data as an
 * empty parse. The bounded read now fails loudly (null) on overflow or
 * stream error, and the cap is 1 MiB.
 */
class ObservatoryApiBodyTest {

    private val api = ObservatoryApi("https://wildfire-observatory.onrender.com")

    @Test
    fun `small body decodes fully`() {
        assertEquals(
            "hello",
            api.readBoundedBody(ByteArrayInputStream("hello".toByteArray()), 10)
        )
    }

    @Test
    fun `body of exactly maxBytes decodes fully - boundary`() {
        assertEquals(
            "0123456789",
            api.readBoundedBody(ByteArrayInputStream("0123456789".toByteArray()), 10)
        )
    }

    @Test
    fun `body of maxBytes plus one is an overflow - null`() {
        assertNull(
            api.readBoundedBody(ByteArrayInputStream("01234567890".toByteArray()), 10)
        )
    }

    @Test
    fun `empty body decodes to empty string`() {
        assertEquals("", api.readBoundedBody(ByteArrayInputStream(ByteArray(0)), 10))
    }

    @Test
    fun `stream failing mid-read returns null`() {
        val failing = object : InputStream() {
            private var calls = 0
            override fun read(): Int {
                if (calls++ >= 3) throw IOException("boom")
                return 'x'.code
            }
        }
        assertNull(api.readBoundedBody(failing, 10))
    }

    @Test
    fun `the response cap is one megabyte`() {
        assertEquals(1 * 1024 * 1024, ObservatoryApi.MAX_RESPONSE_BYTES)
    }
}
