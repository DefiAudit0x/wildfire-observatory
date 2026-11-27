package com.observatory.wildfire

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReportPlacePolicyTest {
    private val old = LocationLogic.FixSnapshot(36.0, 3.0, 5f, 1L, "gps")
    private val moved = old.copy(lat = 37.0, timeMs = 700_000L)
    private val refreshed = old.copy(timeMs = 700_000L)

    @Test
    fun `name only autofill cannot migrate wilaya during backoff`() {
        assertFalse(ReportPlacePolicy.canFillOfflineWilaya(old, moved, true, false, false))
        assertTrue(ReportPlacePolicy.canFillOfflineWilaya(old, refreshed, true, false, false))
        assertTrue(ReportPlacePolicy.canFillOfflineWilaya(old, moved, false, false, false))
    }

    @Test
    fun `manual edit during recovery rejects entire different fix response`() {
        for ((name, wilaya) in listOf(true to false, false to true, true to true)) {
            assertFalse(ReportPlacePolicy.canApplyRecovery(old, moved, name, wilaya))
            assertTrue(ReportPlacePolicy.canApplyRecovery(old, refreshed, name, wilaya))
        }
        assertTrue(ReportPlacePolicy.canApplyRecovery(old, moved, false, false))
    }

    @Test
    fun `explicit rebind allows subsequent lookup for the confirmed fix`() {
        // The confirmation handler clears both place fields and edit flags,
        // then binds to the current fix before starting the new lookup.
        assertTrue(ReportPlacePolicy.canApplyRecovery(moved, moved, false, false))
        assertTrue(ReportPlacePolicy.canFillOfflineWilaya(moved, moved, false, false, false))
    }
}
