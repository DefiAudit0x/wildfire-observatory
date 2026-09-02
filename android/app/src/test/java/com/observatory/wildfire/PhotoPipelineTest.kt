package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * v2.2.0 — the pure sampling math every report photo passes through,
 * whether it comes from the in-app camera or the gallery picker. The
 * Bitmap/compress half is device code by nature (android.jar stubs on the
 * JVM classpath); the loop below is the contract both capture paths share.
 */
class PhotoPipelineTest {

    @Test fun `already under the limit stays at sample 1`() {
        assertEquals(1, PhotoPipeline.targetSample(1280, 960))
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
        // maxDim 1024: 4032 → 2016 → 1008 fits → sample 4
        assertEquals(4, PhotoPipeline.targetSample(4032, 3024, maxDim = 1024))
    }
}
