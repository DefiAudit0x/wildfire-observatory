package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.16.0 (audit wave 3) — EXIF orientation plan contract. The numeric
 * constants mirror android.media.ExifInterface; the mapping must stay
 * EXACT (a mirrored evidentiary frame stamped as unmirrored is a falsified
 * artifact, not a cosmetic bug).
 */
class ExifPlanTest {

    private val p = { o: Int -> TelemetryCamera.exifPlan(o) }

    @Test
    fun `pure rotations map to themselves with no mirror`() {
        assertEquals(TelemetryCamera.ExifPlan(90f, false), p(TelemetryCamera.EXIF_ROTATE_90))
        assertEquals(TelemetryCamera.ExifPlan(180f, false), p(TelemetryCamera.EXIF_ROTATE_180))
        assertEquals(TelemetryCamera.ExifPlan(270f, false), p(TelemetryCamera.EXIF_ROTATE_270))
    }

    @Test
    fun `plain mirror needs no rotation`() {
        assertEquals(TelemetryCamera.ExifPlan(0f, true), p(TelemetryCamera.EXIF_FLIP_HORIZONTAL))
    }

    @Test
    fun `flip vertical equals rotate 180 plus mirror`() {
        // (x,y) → rot180 → (n-1-x, m-1-y) → flipH → (x, m-1-y) = scaleY(-1). ✓
        assertEquals(TelemetryCamera.ExifPlan(180f, true), p(TelemetryCamera.EXIF_FLIP_VERTICAL))
    }

    @Test
    fun `transpose is rotate 90 then mirror (main diagonal)`() {
        // rot90CW: (x,y)→(n-1-y,x); then flipH: →(y,x) — the main diagonal. ✓
        assertEquals(TelemetryCamera.ExifPlan(90f, true), p(TelemetryCamera.EXIF_TRANSPOSE))
    }

    @Test
    fun `transverse is rotate 270 then mirror (anti-diagonal)`() {
        // rot270CW: (x,y)→(y,m-1-x); then flipH: →(n-1-y, m-1-x) — anti-diagonal. ✓
        assertEquals(TelemetryCamera.ExifPlan(270f, true), p(TelemetryCamera.EXIF_TRANSVERSE))
    }

    @Test
    fun `normal and unknown orientations are identity`() {
        assertEquals(TelemetryCamera.ExifPlan(0f, false), p(TelemetryCamera.EXIF_NORMAL))
        assertEquals(TelemetryCamera.ExifPlan(0f, false), p(0))    // UNDEFINED
        assertEquals(TelemetryCamera.ExifPlan(0f, false), p(99))   // hostile/unknown
        assertFalse(p(TelemetryCamera.EXIF_NORMAL).flipH)
    }

    @Test
    fun `exif constants match the platform values`() {
        // android.media.ExifInterface values, pinned so a restatement drift
        // cannot silently corrupt the mapping.
        assertEquals(1, TelemetryCamera.EXIF_NORMAL)
        assertEquals(2, TelemetryCamera.EXIF_FLIP_HORIZONTAL)
        assertEquals(3, TelemetryCamera.EXIF_ROTATE_180)
        assertEquals(4, TelemetryCamera.EXIF_FLIP_VERTICAL)
        assertEquals(5, TelemetryCamera.EXIF_TRANSPOSE)
        assertEquals(6, TelemetryCamera.EXIF_ROTATE_90)
        assertEquals(7, TelemetryCamera.EXIF_TRANSVERSE)
        assertEquals(8, TelemetryCamera.EXIF_ROTATE_270)
    }

    @Test
    fun `output size swaps only for quarter rotations`() {
        assertEquals(
            480 to 640,
            TelemetryCamera.exifOutputSize(640, 480, TelemetryCamera.ExifPlan(90f, false))
        )
        assertEquals(
            480 to 640,
            TelemetryCamera.exifOutputSize(640, 480, TelemetryCamera.ExifPlan(270f, true))
        )
        assertEquals(
            640 to 480,
            TelemetryCamera.exifOutputSize(640, 480, TelemetryCamera.ExifPlan(180f, true))
        )
        assertEquals(
            640 to 480,
            TelemetryCamera.exifOutputSize(640, 480, TelemetryCamera.ExifPlan(0f, true))
        )
        assertTrue(TelemetryCamera.exifPlan(TelemetryCamera.EXIF_TRANSPOSE).flipH)
    }
}
