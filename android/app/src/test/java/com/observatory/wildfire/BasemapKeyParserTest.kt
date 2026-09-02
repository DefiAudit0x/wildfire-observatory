package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * v2.1.1 — Parsers.parseCartoKey contract. The endpoint is flat JSON, so the
 * parser is hand-rolled and JVM-pure (no org.json → runs in unit tests).
 * The cases mirror exactly what the server can answer: a key, json null,
 * an empty string, a missing field, garbage, padded whitespace, and an
 * oversized value (defensive cap at 128 chars).
 */
class BasemapKeyParserTest {

    @Test fun `extracts key from config payload`() {
        assertEquals("cb1_abc123", Parsers.parseCartoKey("""{"cartoKey":"cb1_abc123"}"""))
    }

    @Test fun `json null yields null`() {
        assertNull(Parsers.parseCartoKey("""{"cartoKey":null}"""))
    }

    @Test fun `empty string yields null`() {
        assertNull(Parsers.parseCartoKey("""{"cartoKey":""}"""))
    }

    @Test fun `missing field yields null`() {
        assertNull(Parsers.parseCartoKey("""{"other":"value"}"""))
    }

    @Test fun `garbage bodies yield null`() {
        assertNull(Parsers.parseCartoKey(""))
        assertNull(Parsers.parseCartoKey("not json at all"))
        assertNull(Parsers.parseCartoKey("""{"cartoKey" 123}"""))
    }

    @Test fun `whitespace around the value is tolerated`() {
        assertEquals("k1", Parsers.parseCartoKey("""{ "cartoKey" : "k1" }"""))
    }

    @Test fun `values over the defensive cap are refused`() {
        assertNull(Parsers.parseCartoKey("""{"cartoKey":"${"x".repeat(200)}"}"""))
    }

    @Test fun `first occurrence wins and nested lookalikes are ignored`() {
        assertEquals("real", Parsers.parseCartoKey("""{"cartoKey":"real","note":"cartoKey fake"}"""))
    }
}
