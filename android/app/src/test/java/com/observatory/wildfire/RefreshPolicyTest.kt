package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fix 17 (NREP-1, NREP-2) — pinning specs for the pure refresh-merge
 * policy. The refresh decision used to live inline in `AppRepository`
 * as an OR over identity checks; the empty-body decision did not exist
 * at all (a malformed 200 wiped last-good data).
 */
class RefreshPolicyTest {

    // ---------- NREP-1: refreshSucceeded ----------

    @Test
    fun `all four succeed including genuinely empty lists`() {
        assertTrue(RefreshPolicy.refreshSucceeded(listOf(1), listOf(2), listOf(3), listOf(4)))
        assertTrue(RefreshPolicy.refreshSucceeded(emptyList<Int>(), emptyList(), emptyList(), emptyList()))
    }

    @Test
    fun `exactly one failure means the pass did not fully succeed`() {
        val ok = listOf(1)
        assertFalse(RefreshPolicy.refreshSucceeded(null, ok, ok, ok))
        assertFalse(RefreshPolicy.refreshSucceeded(ok, null, ok, ok))
        assertFalse(RefreshPolicy.refreshSucceeded(ok, ok, null, ok))
        assertFalse(RefreshPolicy.refreshSucceeded(ok, ok, ok, null))
    }

    @Test
    fun `all four failing means the pass did not succeed`() {
        assertFalse(RefreshPolicy.refreshSucceeded(null, null, null, null))
    }

    // ---------- NREP-2: isGenuineEmptyBody ----------

    @Test
    fun `genuine empty arrays are accepted`() {
        assertTrue(RefreshPolicy.isGenuineEmptyBody("[]"))
        assertTrue(RefreshPolicy.isGenuineEmptyBody("[ ]"))
        assertTrue(RefreshPolicy.isGenuineEmptyBody("[\n]"))
        assertTrue(RefreshPolicy.isGenuineEmptyBody("  []  "))
    }

    @Test
    fun `malformed and non-array bodies are not genuine empty arrays`() {
        assertFalse(RefreshPolicy.isGenuineEmptyBody("{}"))
        assertFalse(RefreshPolicy.isGenuineEmptyBody(""))
        assertFalse(RefreshPolicy.isGenuineEmptyBody("null"))
        assertFalse(RefreshPolicy.isGenuineEmptyBody("not json"))
        assertFalse(RefreshPolicy.isGenuineEmptyBody("[{\"id\":1},"))
        assertFalse(RefreshPolicy.isGenuineEmptyBody("<html><body>error</body></html>"))
    }

    @Test
    fun `a non-empty array is not a genuine empty body`() {
        assertFalse(RefreshPolicy.isGenuineEmptyBody("[1,2]"))
        assertFalse(RefreshPolicy.isGenuineEmptyBody("[{\"id\":1}]"))
    }

    @Test
    fun `fail-without-fix shape - one failure must not read as success`() {
        // The old OR/identity logic stamped a pass successful when ANY
        // list was new; the AND rule is what this test pins. A single
        // null among four fetches is a partial refresh, never a full one.
        assertEquals(false, RefreshPolicy.refreshSucceeded(listOf(1), listOf(2), listOf(3), null))
    }
}
