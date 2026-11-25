package com.observatory.wildfire

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.2.0 — the pure sampling math every report photo passes through,
 * whether it comes from the in-app camera or the gallery picker. The
 * Bitmap/compress half is device code by nature (android.jar stubs on the
 * JVM classpath); the loop below is the contract both capture paths share.
 */
class PhotoPipelineTest {

    @Test fun `already under the limit stays at sample 1`() {
        // Genuinely under the limit on the longest side (1279 < 1280):
        // the old input (1280, 960) sat exactly AT the limit and duplicated
        // the boundary test below. Boundary triplet: 1279 → 1, 1280 → 1,
        // 1281 → 2.
        assertEquals(1, PhotoPipeline.targetSample(1279, 960))
    }

    @Test fun `exactly at the limit stays at sample 1`() {
        assertEquals(1, PhotoPipeline.targetSample(1280, 1280))
    }

    @Test fun `one pixel over doubles the sample`() {
        // 1281/1 > 1280 → sample 2 → 640 fits
        assertEquals(2, PhotoPipeline.targetSample(1281, 720))
    }

    @Test fun `a 48MP shot needs sample 8`() {
        // 8000 → 4000 → 2000 → 1000 fits
        assertEquals(8, PhotoPipeline.targetSample(8000, 6000))
    }

    @Test fun `a 12MP camera frame needs sample 4`() {
        // 4032 → 2016 → 1008 fits (width drives, height follows)
        assertEquals(4, PhotoPipeline.targetSample(4032, 3024))
    }

    @Test fun `unknown bounds (decode failure) safely return 1`() {
        assertEquals(1, PhotoPipeline.targetSample(-1, -1))
    }

    @Test fun `zero dimensions safely return 1`() {
        assertEquals(1, PhotoPipeline.targetSample(0, 0))
    }

    @Test fun `portrait mega-shot obeys the taller edge`() {
        // 6000 tall drives: 6000 → 3000 → 1500 → 750 fits
        assertEquals(8, PhotoPipeline.targetSample(4500, 6000))
    }

    @Test fun `custom maxDim is honored`() {
        // The old input (4032, 3024) gave sample 4 at BOTH 1024 and the
        // default 1280 (4032 → 2016 → 1008 fits under either), so ignoring
        // maxDim passed. (2560, 1920) discriminates: 2560 → 1280 fits the
        // default (sample 2) but not 1024 (sample 4).
        assertEquals(2, PhotoPipeline.targetSample(2560, 1920))
        assertEquals(4, PhotoPipeline.targetSample(2560, 1920, maxDim = 1024))
    }

    // ---------- Fix 19 (NPHOTO-1): the decoded-byte budget must fit the wire gate ----------

    @Test fun `MAX_BYTES data URI fits the 500000 char wire gate`() {
        // A data URI is the 23-char "data:image/jpeg;base64," prefix +
        // base64 (4 chars per 3 bytes, NO_WRAP). Fail-without-fix:
        // reverting MAX_BYTES to 450,000 makes this fail (600,023).
        val dataUriChars = 23 + ((PhotoPipeline.MAX_BYTES + 2) / 3) * 4
        assertTrue(dataUriChars <= 500_000)
    }

    @Test fun `the exact budget boundary is 374982 bytes`() {
        // 374,982 -> 499,976 + 23 = 499,999 fits; one byte more does not.
        assertEquals(499_999, 23 + ((374_982 + 2) / 3) * 4)
        assertTrue(23 + ((374_983 + 2) / 3) * 4 > 500_000)
        // The tempting round number does NOT fit — do not "round it up".
        assertTrue(23 + ((375_000 + 2) / 3) * 4 > 500_000)
    }

    // ---------- Fix 19 (NCAM-2): the atomic write ----------

    private fun tempDir(): File =
        java.nio.file.Files.createTempDirectory("atomic-write-test").toFile()

    @Test fun `a successful atomic write replaces the original and leaves no temp`() {
        val dir = tempDir()
        try {
            val target = File(dir, "capture.jpg")
            target.writeText("old")
            assertTrue(PhotoPipeline.writeAtomically(target) { out ->
                out.write("new".toByteArray())
                true
            })
            assertEquals("new", target.readText())
            assertFalse(File(dir, "capture.jpg.stamped").exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun `a writer that reports failure leaves the original intact and deletes the temp`() {
        val dir = tempDir()
        try {
            val target = File(dir, "capture.jpg")
            target.writeText("old")
            assertFalse(PhotoPipeline.writeAtomically(target) { out ->
                out.write("partial".toByteArray())
                false
            })
            assertEquals("old", target.readText())
            assertFalse(File(dir, "capture.jpg.stamped").exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun `a writer that throws leaves the original intact and deletes the temp`() {
        val dir = tempDir()
        try {
            val target = File(dir, "capture.jpg")
            target.writeText("old")
            assertFalse(PhotoPipeline.writeAtomically(target) { _ ->
                throw RuntimeException("boom")
            })
            assertEquals("old", target.readText())
            assertFalse(File(dir, "capture.jpg.stamped").exists())
        } finally {
            dir.deleteRecursively()
        }
    }
}
