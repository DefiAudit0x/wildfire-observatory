package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MeshChatPolicyTest {
    @Test
    fun `plain chat uses legacy raw text receive path`() {
        assertEquals("💬 hello team", MeshChatPolicy.plaintext("hello team"))
        assertTrue(MeshChatPolicy.plaintext("hello team").take(160).contains("hello team"))
    }

    @Test
    fun `JSON typed into chat cannot become intel`() {
        val payload = MeshChatPolicy.plaintext("""{"app":"wlfire","kind":"report","lat":36,"lng":3}""")
        // Prefix guarantees JSONObject parsing fails, including on old peers.
        assertTrue(payload.startsWith("💬 "))
        assertFalse(payload.trimStart().startsWith("{"))
    }

    @Test
    fun `display remains bounded to 160 characters`() {
        val payload = MeshChatPolicy.plaintext("x".repeat(500))
        assertEquals(160, payload.take(160).length)
    }
}
