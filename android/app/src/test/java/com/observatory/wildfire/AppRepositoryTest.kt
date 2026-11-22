package com.observatory.wildfire

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fix 18 follow-ups (NREP-5): JVM tests for the two pure companion
 * helpers in [AppRepository]. The drain-loop wiring that calls them is
 * verified by code review + CI build (no AppRepository harness exists);
 * these tests pin the helpers themselves, with real temp files for the
 * durable write.
 */
class AppRepositoryTest {

    // ---------- Fix 18b: the terminal 409 matcher ----------

    @Test
    fun `the already-received-recently 409 is terminal`() {
        assertTrue(
            AppRepository.isAlreadyReceivedRecentlyMessage(
                "An SOS from this device was already received recently"
            )
        )
    }

    @Test
    fun `the other SOS 409s are not terminal`() {
        assertFalse(
            AppRepository.isAlreadyReceivedRecentlyMessage(
                "SOS retry key belongs to a different device"
            )
        )
        assertFalse(
            AppRepository.isAlreadyReceivedRecentlyMessage("This SOS is already resolved")
        )
        assertFalse(
            AppRepository.isAlreadyReceivedRecentlyMessage(
                "This team is already dispatched to an active SOS"
            )
        )
    }

    @Test
    fun `a missing or blank message is not terminal`() {
        assertFalse(AppRepository.isAlreadyReceivedRecentlyMessage(null))
        assertFalse(AppRepository.isAlreadyReceivedRecentlyMessage(""))
        assertFalse(AppRepository.isAlreadyReceivedRecentlyMessage("   "))
    }

    // ---------- Fix 18c: the durable write ----------

    private fun tempDir(): File =
        java.nio.file.Files.createTempDirectory("durable-write-test").toFile()

    @Test
    fun `durable write lands exact bytes and leaves no temp file`() {
        val dir = tempDir()
        try {
            val tmp = File(dir, "queue_sos.json.tmp")
            val target = File(dir, "queue_sos.json")
            assertTrue(AppRepository.writeFileDurably(tmp, target, "hello".toByteArray()))
            assertEquals("hello", target.readText())
            assertFalse(tmp.exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a second durable write replaces the previous file`() {
        val dir = tempDir()
        try {
            val tmp = File(dir, "queue_sos.json.tmp")
            val target = File(dir, "queue_sos.json")
            assertTrue(AppRepository.writeFileDurably(tmp, target, "first".toByteArray()))
            assertTrue(AppRepository.writeFileDurably(tmp, target, "second".toByteArray()))
            assertEquals("second", target.readText())
            assertFalse(tmp.exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a failed durable write keeps the previous file intact`() {
        val dir = tempDir()
        try {
            val target = File(dir, "queue_sos.json")
            target.writeText("old")
            val tmp = File(File(dir, "no-such-dir"), "queue_sos.json.tmp")
            assertFalse(AppRepository.writeFileDurably(tmp, target, "new".toByteArray()))
            assertEquals("old", target.readText())
        } finally {
            dir.deleteRecursively()
        }
    }
}
