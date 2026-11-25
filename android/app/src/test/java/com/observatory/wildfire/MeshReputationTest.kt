package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ARC-H16 pinning specs for the TOFU reputation module extracted from
 * MeshService. Pinned here: the audit-B2 differentiated penalties are just
 * constants (clamped band), TOFU creation at REPUTATION_INITIAL, the strict
 * admission threshold (> REPUTATION_MIN / 2), quarantine below the floor,
 * and the least-recently-seen cap eviction (MAX_DEVICE_RECORDS).
 */
class MeshReputationTest {

    private val K = "AAAA_KEY_1"

    @Test
    fun sightCreatesTofuRecordAtInitialScore() {
        val r = MeshReputation()
        r.sight(K, now = 1000L)
        val rec = r.deviceRecords[K]!!
        assertEquals(MeshReputation.REPUTATION_INITIAL, rec.reputation)
        assertEquals(1000L, rec.firstSeen)
        assertEquals(1000L, rec.lastSeen)
    }

    @Test
    fun repeatSightKeepsExistingRecordAndHistory() {
        val r = MeshReputation()
        r.sight(K, now = 1000L)
        r.update(K, +10, now = 2000L)
        val before = r.deviceRecords[K]!!
        r.sight(K, now = 3000L)
        val after = r.deviceRecords[K]!!
        // Same record object survives; scoring history is not reset.
        assertTrue(before === after)
        assertEquals(60, after.reputation)
        assertEquals(1000L, after.firstSeen)
        // Repeat sight refreshes NOTHING (MeshReputation.kt:62–66): lastSeen
        // stays at the scoring update's 2000, not the repeat sight's 3000.
        assertEquals(2000L, after.lastSeen)
    }

    @Test
    fun updateClampsToReputationBand() {
        val r = MeshReputation()
        r.sight(K, now = 1L)
        assertEquals(MeshReputation.REPUTATION_MAX, r.update(K, +10_000, now = 2L))
        assertEquals(MeshReputation.REPUTATION_MIN, r.update(K, -10_000, now = 3L))
    }

    @Test
    fun updateOnUnknownKeyCreatesRecordFromInitial() {
        val r = MeshReputation()
        // Original updateReputation compute fallback: base = INITIAL, then delta.
        assertEquals(45, r.update(K, -5, now = 7L))
        assertEquals(45, r.score(K))
        assertEquals(7L, r.deviceRecords[K]!!.lastSeen)
    }

    @Test
    fun scoreFallsBackToInitialForUnknownKey() {
        val r = MeshReputation()
        assertEquals(MeshReputation.REPUTATION_INITIAL, r.score("unknown"))
        assertFalse(r.known("unknown"))
    }

    @Test
    fun admissionThresholdIsStrictlyAboveQuarantineFloor() {
        val r = MeshReputation()
        r.sight(K, now = 1L)
        val floor = MeshReputation.REPUTATION_MIN / 2 // -50
        // Strictly above the floor → admitted.
        r.update(K, floor - MeshReputation.REPUTATION_INITIAL + 1, now = 2L) // -49
        assertTrue(r.isAdmitted(K))
        // Exactly at the floor → NOT admitted (original `> REPUTATION_MIN / 2`).
        r.update(K, -1, now = 3L) // -50
        assertFalse(r.isAdmitted(K))
        r.update(K, -1, now = 4L) // -51
        assertFalse(r.isAdmitted(K))
    }

    @Test
    fun firstInboundContactIsSightedBeforeAdmissionCheck() {
        val r = MeshReputation()

        assertTrue(r.sightAndCheckAdmission(K, now = 10L))
        assertEquals(MeshReputation.REPUTATION_INITIAL, r.score(K))
        assertTrue(r.known(K))
    }

    @Test
    fun quarantinedKeyCannotReenterThroughInboundHandshake() {
        val r = MeshReputation()
        r.sight(K, now = 1L)
        r.quarantine(K, now = 2L)

        assertFalse(r.sightAndCheckAdmission(K, now = 3L))
        assertEquals(MeshReputation.REPUTATION_MIN / 2 - 1, r.score(K))
    }

    @Test
    fun inboundFramesRequireAdmissionForKnownKeys() {
        val r = MeshReputation()
        r.sight(K, now = 1L)
        assertTrue(r.isInboundAdmitted(K))

        r.quarantine(K, now = 2L)
        assertFalse(r.isInboundAdmitted(K))
        assertTrue(r.isInboundAdmitted(null))
    }

    @Test
    fun quarantineDropsBelowAdmissionFloorButKeepsRecord() {
        val r = MeshReputation()
        r.sight(K, now = 1L)
        r.quarantine(K, now = 50L)
        val rec = r.deviceRecords[K]!!
        assertEquals(MeshReputation.REPUTATION_MIN / 2 - 1, rec.reputation)
        assertEquals(50L, rec.lastSeen)
        assertFalse(r.isAdmitted(K))
    }

    @Test
    fun capEvictsLeastRecentlySeen() {
        val r = MeshReputation()
        val total = MeshReputation.MAX_DEVICE_RECORDS + 5
        // Keys 0..4 are the oldest; keys 5.. are progressively fresher.
        for (i in 0 until total) {
            val key = "KEY_$i"
            r.sight(key, now = i.toLong() + 1)
        }
        assertEquals(MeshReputation.MAX_DEVICE_RECORDS, r.deviceRecords.size)
        for (i in 0 until 5) assertFalse(r.known("KEY_$i"))
        for (i in 5 until total) assertTrue(r.known("KEY_$i"))
    }

    @Test
    fun capEvictionUsesLastSeenNotFirstSeen() {
        val r = MeshReputation()
        // KEY_0 is the OLDEST by creation, but a scoring refresh moves
        // its lastSeen far ahead — the cap must evict by lastSeen, not
        // firstSeen.
        r.sight("KEY_0", now = 1L)
        for (i in 1 until MeshReputation.MAX_DEVICE_RECORDS) {
            r.sight("KEY_$i", now = i.toLong() + 1)
        }
        // Scoring refresh: reputation unchanged (delta 0), lastSeen moves.
        r.update("KEY_0", 0, now = 2000L)
        assertEquals(2000L, r.deviceRecords["KEY_0"]!!.lastSeen)
        assertEquals(1L, r.deviceRecords["KEY_0"]!!.firstSeen)
        // Five more sights force five evictions; the five
        // least-recently-SEEN keys (KEY_1..KEY_5, lastSeen 2..6) must go,
        // not the refreshed KEY_0.
        for (i in 0 until 5) {
            r.sight("KEY_${MeshReputation.MAX_DEVICE_RECORDS + i}", now = 2001L + i)
        }
        assertEquals(MeshReputation.MAX_DEVICE_RECORDS, r.deviceRecords.size)
        assertTrue(r.known("KEY_0"))
        for (i in 1..5) assertFalse(r.known("KEY_$i"))
        for (i in 6 until MeshReputation.MAX_DEVICE_RECORDS) assertTrue(r.known("KEY_$i"))
        for (i in 0 until 5) assertTrue(r.known("KEY_${MeshReputation.MAX_DEVICE_RECORDS + i}"))
    }

    @Test
    fun differentiatedPenaltyConstantsArePinned() {
        // Audit B2: offenses are ranked by severity — pin the ladder so a
        // reordering cannot happen silently.
        assertEquals(50, MeshReputation.REPUTATION_INITIAL)
        assertEquals(5, MeshReputation.REPUTATION_CONFIRM_MATCH)
        assertEquals(-10, MeshReputation.REPUTATION_MALFORMED_FRAME)
        assertEquals(-20, MeshReputation.REPUTATION_BAD_POW)
        assertEquals(-30, MeshReputation.REPUTATION_BAD_DIFFICULTY)
        assertEquals(-40, MeshReputation.REPUTATION_BAD_SIGNATURE)
        assertEquals(-100, MeshReputation.REPUTATION_MIN)
        assertEquals(100, MeshReputation.REPUTATION_MAX)
        assertEquals(1024, MeshReputation.MAX_DEVICE_RECORDS)
    }

    @Test
    fun evictedLiveKeyIsReadmittedBySightThenCheck() {
        // Fix 7b (CodeRabbit thread B): a live peer whose record was evicted
        // by the bounded cap must be re-sighted at REPUTATION_INITIAL by
        // the frame gate's sight-then-check instead of being dropped forever.
        val r = MeshReputation()
        r.sight(K, now = 1L)
        // Fill the table with newer keys so K (the stalest) is evicted.
        val total = MeshReputation.MAX_DEVICE_RECORDS + 1
        for (i in 0 until total) {
            r.sight("KEY_$i", now = i.toLong() + 2)
        }
        assertFalse(r.known(K))

        assertTrue(r.sightAndCheckAdmission(K, now = 5000L))
        assertTrue(r.known(K))
        assertEquals(MeshReputation.REPUTATION_INITIAL, r.score(K))
    }

    @Test
    fun retainedQuarantinedRecordStaysRejectedUnderEvictionPressure() {
        // Fix 7b (CodeRabbit thread B): sight() never resets a RETAINED
        // record, so a quarantined key stays rejected even while the table
        // is under eviction pressure — the quarantined record is the
        // freshest here, so the cap evicts older keys instead of it.
        val r = MeshReputation()
        r.sight(K, now = 1L)
        r.quarantine(K, now = 5000L)
        val total = MeshReputation.MAX_DEVICE_RECORDS + 1
        for (i in 0 until total) {
            r.sight("KEY_$i", now = i.toLong() + 2)
        }
        assertTrue(r.known(K))
        assertFalse(r.sightAndCheckAdmission(K, now = 6000L))
        assertEquals(MeshReputation.REPUTATION_MIN / 2 - 1, r.score(K))
    }
}
