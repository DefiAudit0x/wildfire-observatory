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
 *     The ceiling is a DECODED-byte budget derived from the wire budget:
 *     a data URI is "data:image/jpeg;base64," (23 chars) + base64 (4 chars
 *     per 3 bytes), and ApiPayloads/the server reject a data URI over
 *     500,000 chars. 374,982 is the largest byte count whose data URI
 *     fits (499,976 + 23 = 499,999); 375,000 does NOT fit (500,023).
 *
 * The Bitmap side is device code by nature (android.graphics is stubbed on
 * the JVM test classpath); the sampling math and the atomic-write helper
 * are unit-tested, the compress loop is not.
 */
object PhotoPipeline {

    const val MAX_DIM_PX = 1280
    const val MAX_BYTES = 374_982
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
     * then q -= 15, looping while still oversized AND q >= 20 — so the floor
     * quality itself is always attempted.
     */
    fun compressWithinBudget(bitmap: Bitmap, maxBytes: Int = MAX_BYTES): ByteArray? {
        var quality = START_QUALITY
        var bytes: ByteArray
        do {
            val out = ByteArrayOutputStream()
            // Fix 51 (NPHOTO-3): a failed encode returns false and leaves
            // the stream empty — returning those 0 bytes as success made
            // the caller announce an empty image as attached. Fail fast:
            // encoder failures are deterministic across qualities, so
            // stepping down cannot rescue them.
            val ok = bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (!ok) return null
            bytes = out.toByteArray()
            quality -= QUALITY_STEP
        } while (bytes.size > maxBytes && quality >= FLOOR_QUALITY)
        return if (bytes.size > maxBytes) null else bytes
    }

    /**
     * Fix 19 (NCAM-2): write to a temp file in the SAME directory as
     * [target] and rename it over [target] only when the writer reports
     * success and the temp file is non-empty. The temp lives beside the
     * target, so the rename stays on one filesystem and is atomic. Any
     * failure (writer false, writer throws, empty temp, failed rename)
     * deletes the temp and returns false — [target] is never opened for
     * writing, so the original bytes survive intact for the caller's raw
     * fallback. Pure java.io — JVM-testable with real temp files.
     */
    internal fun writeAtomically(target: java.io.File, write: (java.io.OutputStream) -> Boolean): Boolean {
        val parent = target.parentFile ?: return false
        val tmp = java.io.File(parent, "${target.name}.stamped")
        val wroteOk = try {
            tmp.outputStream().use { out -> write(out) }
        } catch (e: Exception) {
            false
        }
        if (!wroteOk || tmp.length() <= 0) {
            tmp.delete()
            return false
        }
        if (!tmp.renameTo(target)) {
            tmp.delete()
            return false
        }
        return true
    }
}
