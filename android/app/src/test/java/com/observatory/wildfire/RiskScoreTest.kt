package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RiskScoreTest {

    @Test
    fun `empty field is zero`() {
        assertEquals(0, RiskScore.score(emptyList(), 0))
        assertEquals("لا توجد مؤشرات خطر حالية", RiskScore.labelAr(0))
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

    @Test
    fun `labels match the five color bands`() {
        assertEquals("لا توجد مؤشرات خطر حالية", RiskScore.labelAr(0))
        assertEquals("خطر منخفض", RiskScore.labelAr(1))
        assertEquals("خطر منخفض", RiskScore.labelAr(19))
        assertEquals("خطر متوسط", RiskScore.labelAr(20))
        assertEquals("خطر متوسط", RiskScore.labelAr(39))
        assertEquals("خطر مرتفع", RiskScore.labelAr(40))
        assertEquals("خطر مرتفع", RiskScore.labelAr(59))
        assertEquals("خطر مرتفع جدًا", RiskScore.labelAr(60))
        assertEquals("خطر مرتفع جدًا", RiskScore.labelAr(79))
        assertEquals("خطر كارثي", RiskScore.labelAr(80))
        assertEquals("خطر كارثي", RiskScore.labelAr(100))
    }

    @Test
    fun `band colors are sage below 20`() {
        assertEquals(0xFFC5D9BF.toInt(), RiskScore.bandColor(0))
        assertEquals(0xFFC5D9BF.toInt(), RiskScore.bandColor(10))
        assertEquals(0xFFC5D9BF.toInt(), RiskScore.bandColor(19))
    }

    @Test
    fun `band colors are lime from 20 to 39`() {
        assertEquals(0xFF8DB63C.toInt(), RiskScore.bandColor(20))
        assertEquals(0xFF8DB63C.toInt(), RiskScore.bandColor(30))
        assertEquals(0xFF8DB63C.toInt(), RiskScore.bandColor(39))
    }

    @Test
    fun `band colors are orange from 40 to 59`() {
        assertEquals(0xFFFF6B35.toInt(), RiskScore.bandColor(40))
        assertEquals(0xFFFF6B35.toInt(), RiskScore.bandColor(50))
        assertEquals(0xFFFF6B35.toInt(), RiskScore.bandColor(59))
    }

    @Test
    fun `band colors are burnt orange then red above 60`() {
        assertEquals(0xFFF04E1F.toInt(), RiskScore.bandColor(60))
        assertEquals(0xFFF04E1F.toInt(), RiskScore.bandColor(70))
        assertEquals(0xFFF04E1F.toInt(), RiskScore.bandColor(79))
        assertEquals(0xFFD21034.toInt(), RiskScore.bandColor(80))
        assertEquals(0xFFD21034.toInt(), RiskScore.bandColor(90))
        assertEquals(0xFFD21034.toInt(), RiskScore.bandColor(100))
    }
}
