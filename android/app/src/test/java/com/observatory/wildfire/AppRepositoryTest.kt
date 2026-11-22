package com.observatory.wildfire

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fix 18 follow-up (NREP-5): JVM tests for the pure companion helper
 * [AppRepository.writeFileDurably]. The helper's directory sync is a
 * seam: the real [AppRepository.syncDirectory] uses android.system.Os,
 * which is a stub that throws in JVM unit tests, so these tests pass a
 * fake (`{ true }` / `{ false }`) and exercise the file-write, rename
 * and failure paths around it. The real directory sync is proven by
 * compilation (CI build) and device behaviour, not by a unit test —
 * stated honestly. The drain-loop wiring that calls the helper is
 * verified by code review + CI build (no AppRepository harness exists).
 *
 * History: the first 18c attempt synced the directory with
 * `FileInputStream(dir)` — rejected on Android (IoBridge) and on the
 * JVM (OpenJDK's directory check) — and both success tests below
 * failed on CI with the helper returning false. The Os-based seam
 * replaces it.
 */
class AppRepositoryTest {

    private fun tempDir(): File =
        java.nio.file.Files.createTempDirectory("durable-write-test").toFile()

    @Test
    fun `durable write lands exact bytes and leaves no temp file`() {
        val dir = tempDir()
        try {
            val tmp = File(dir, "queue_sos.json.tmp")
            val target = File(dir, "queue_sos.json")
            assertTrue(AppRepository.writeFileDurably(tmp, target, "hello".toByteArray()) { true })
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
            assertTrue(AppRepository.writeFileDurably(tmp, target, "first".toByteArray()) { true })
            assertTrue(AppRepository.writeFileDurably(tmp, target, "second".toByteArray()) { true })
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
            assertFalse(AppRepository.writeFileDurably(tmp, target, "new".toByteArray()) { true })
            assertEquals("old", target.readText())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a failed directory sync reports failure but keeps the new file`() {
        val dir = tempDir()
        try {
            val tmp = File(dir, "queue_sos.json.tmp")
            val target = File(dir, "queue_sos.json")
            target.writeText("old")
            assertFalse(AppRepository.writeFileDurably(tmp, target, "new".toByteArray()) { false })
            // Post-rename failure (CodeRabbit Minor 4660269800): the new
            // contents are in place, only their durability is
            // unconfirmed — the old file is NOT intact here.
            assertEquals("new", target.readText())
            assertFalse(tmp.exists())
        } finally {
            dir.deleteRecursively()
        }
    }
}
