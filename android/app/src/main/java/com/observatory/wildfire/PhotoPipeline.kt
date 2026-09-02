package com.observatory.wildfire

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream

/**
 * v2.2.0 — the single photo path for report images, shared by the gallery
 * picker (ReportFragment.onActivityResult) and the in-app camera
 * (CameraCaptureFragment). Two stages, identical for both sources:
 *
 *  1. sample — power-of-two inSampleSize bringing both edges under 1280px
 *     (pure math, JVM-tested in PhotoPipelineTest);
 *  2. compress — JPEG quality steps 80 → 20 until the data-URI budget holds.
 *     The 450KB ceiling keeps the base64 payload under the server's 500KB
 *     imageValidate cap with headroom for the "data:image/jpeg;base64,"
 *     prefix and the JSON envelope.
 *
 * The Bitmap side is device code by nature (android.graphics is stubbed on
 * the JVM test classpath); only the sampling math is unit-tested.
 */
object PhotoPipeline {

    const val MAX_DIM_PX = 1280
    const val MAX_BYTES = 450_000
    const val START_QUALITY = 80
    const val FLOOR_QUALITY = 20
    const val QUALITY_STEP = 15

    /**
     * Power-of-two inSampleSize that brings BOTH edges under [maxDim].
     * Mirrors the exact loop the gallery picker shipped with since v2.0.0
     * (width/sample > maxDim || height/sample > maxDim → sample *= 2), now
     * the one implementation both capture paths call. Degenerate inputs
     * (unknown bounds = -1, zero) safely return 1 — decode then decides.
     */
    fun targetSample(width: Int, height: Int, maxDim: Int = MAX_DIM_PX): Int {
        var sample = 1
        while (width / sample > maxDim || height / sample > maxDim) sample *= 2
        return sample
    }

    /**
     * JPEG-compress stepping the quality down until [maxBytes] holds; null
     * when even the floor quality overshoots (caller shows "too big").
     * Byte-identical behavior to the v2.0.0 picker loop: compress at q,
     * then q -= 15, looping while still oversized AND q > 20 — so the floor
     * quality itself is always attempted.
     */
    fun compressWithinBudget(bitmap: Bitmap, maxBytes: Int = MAX_BYTES): ByteArray? {
        var quality = START_QUALITY
        var bytes: ByteArray
        do {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            bytes = out.toByteArray()
            quality -= QUALITY_STEP
        } while (bytes.size > maxBytes && quality > FLOOR_QUALITY)
        return if (bytes.size > maxBytes) null else bytes
    }
}
