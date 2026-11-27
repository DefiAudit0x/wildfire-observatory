package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MeshIdentityBindingTest {
    @Test
    fun `issued ID is deterministic key bound and fits existing wire limit`() {
        val id = MeshIdentityBinding.issue("public-key-one")
        assertEquals(63, id.length)
        assertEquals(id, MeshIdentityBinding.issue("public-key-one"))
        assertTrue(MeshIdentityBinding.accepts(id, "public-key-one"))
        assertFalse(MeshIdentityBinding.accepts(id, "public-key-two"))
        assertFalse(MeshIdentityBinding.accepts("k1:invalid", "public-key-one"))
    }

    @Test
    fun `legacy random IDs remain interoperable but unbound in phase one`() {
        val legacy = "abc012def345gh67"
        assertTrue(MeshIdentityBinding.accepts(legacy, "public-key-one"))
        assertTrue(MeshIdentityBinding.accepts(legacy, "public-key-two"))
    }
}
