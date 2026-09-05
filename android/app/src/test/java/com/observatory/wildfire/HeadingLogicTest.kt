package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.19.0 — the compass math pins. The radar's heading-up card is only as
 * trustworthy as these three functions; a wrap bug here reads as a compass
 * spinning wildly at north — the one direction you cannot afford to lie in.
 */
class HeadingLogicTest {

    @Test
    fun `angleDelta shortest path across the 359-1 wrap`() {
        assertEquals(20.0, HeadingLogic.angleDeltaDeg(350.0, 10.0), 1e-9)
        assertEquals(-20.0, HeadingLogic.angleDeltaDeg(10.0, 350.0), 1e-9)
        assertEquals(0.0, HeadingLogic.angleDeltaDeg(45.0, 45.0), 1e-9)
        assertEquals(180.0, HeadingLogic.angleDeltaDeg(0.0, 180.0), 1e-9)
        assertEquals(-90.0, HeadingLogic.angleDeltaDeg(90.0, 0.0), 1e-9)
        assertEquals(90.0, HeadingLogic.angleDeltaDeg(315.0, 45.0), 1e-9)
    }

    @Test
    fun `smoothAngle follows wrap without exploding`() {
        // 350 → 10 must smooth UP through north (+20 step), not spin -340.
        val v = HeadingLogic.smoothAngleDeg(350.0, 10.0, 0.25)
        assertEquals(355.0, v, 1e-9)
    }

    @Test
    fun `smoothAngle alpha extremes`() {
        assertEquals(42.0, HeadingLogic.smoothAngleDeg(350.0, 42.0, 1.0), 1e-9)
        assertEquals(350.0, HeadingLogic.smoothAngleDeg(350.0, 42.0, 0.0), 1e-9)
    }

    @Test
    fun `normalize wraps negatives and over-rotations`() {
        assertEquals(350.0, HeadingLogic.normalizeDeg(-10.0), 1e-9)
        assertEquals(0.0, HeadingLogic.normalizeDeg(360.0), 1e-9)
        assertEquals(15.0, HeadingLogic.normalizeDeg(375.0), 1e-9)
        assertTrue(HeadingLogic.normalizeDeg(-720.0) in 0.0..360.0)
    }
}
