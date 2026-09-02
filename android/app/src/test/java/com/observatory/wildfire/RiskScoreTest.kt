package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RiskScoreTest {

    @Test
    fun `empty field is zero`() {
        assertEquals(0, RiskScore.score(emptyList(), 0))
        assertEquals("لا خطر مرصود", RiskScore.labelAr(0))
    }

    @Test
    fun `verified critical outweighs pending critical`() {
        val verified = RiskScore.score(listOf("critical" to true), 0)
        val pending = RiskScore.score(listOf("critical" to false), 0)
        assertEquals(RiskScore.W_VERIFIED_CRITICAL, verified)
        // Math.round half-UP: 25 * 0.5 = 12.5 → 13.
        assertEquals(Math.round(RiskScore.W_VERIFIED_CRITICAL * RiskScore.PENDING_FACTOR).toInt(), pending)
        assertTrue(verified > pending)
    }

    @Test
    fun `severity weights are strictly ordered`() {
        val crit = RiskScore.score(listOf("critical" to true), 0)
        val high = RiskScore.score(listOf("high" to true), 0)
        val medium = RiskScore.score(listOf("medium" to true), 0)
        val low = RiskScore.score(listOf("low" to true), 0)
        assertTrue(crit > high && high > medium && medium > low)
    }

    @Test
    fun `hotspot bonus caps at 25`() {
        assertEquals(25, RiskScore.score(emptyList(), 999))
        assertEquals(10, RiskScore.score(emptyList(), 10))
    }

    @Test
    fun `score clamps at 100`() {
        val floods = List(20) { "critical" to true }
        assertEquals(100, RiskScore.score(floods, 999))
    }

    @Test
    fun `rejected severity contributes nothing`() {
        assertEquals(0, RiskScore.score(listOf("rejected" to true, "rejected" to false), 0))
    }

    @Test
    fun `labels ascend with score`() {
        assertTrue(RiskScore.labelAr(80) != RiskScore.labelAr(60))
        assertEquals("خطر كارثي", RiskScore.labelAr(90))
        assertEquals("خطر متوسط", RiskScore.labelAr(30))
    }
}
