package com.observatory.wildfire

import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Test

class NativeMainActivityTest {

    @Test
    fun `empty results are not granted`() {
        assertEquals(false, NativeMainActivity.allGranted(intArrayOf()))
    }

    @Test
    fun `all granted passes`() {
        assertEquals(
            true,
            NativeMainActivity.allGranted(
                intArrayOf(
                    PackageManager.PERMISSION_GRANTED,
                    PackageManager.PERMISSION_GRANTED
                )
            )
        )
    }

    @Test
    fun `first granted second denied fails`() {
        // Fix 57 (NACT-1): the old grantResults[0] check returned true here.
        assertEquals(
            false,
            NativeMainActivity.allGranted(
                intArrayOf(
                    PackageManager.PERMISSION_GRANTED,
                    PackageManager.PERMISSION_DENIED
                )
            )
        )
    }

    @Test
    fun `first denied rest granted fails`() {
        assertEquals(
            false,
            NativeMainActivity.allGranted(
                intArrayOf(
                    PackageManager.PERMISSION_DENIED,
                    PackageManager.PERMISSION_GRANTED
                )
            )
        )
    }

    @Test
    fun `single denied fails`() {
        assertEquals(false, NativeMainActivity.allGranted(intArrayOf(PackageManager.PERMISSION_DENIED)))
    }
}
