package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.16.0 — contract tests for the two-phase queue (audit wave 3: no I/O
 * under the lock). reserveDue() takes, commit() settles; the transport runs
 * between the two phases OUTSIDE the queue's monitor.
 */
class OfflineQueueTest {

    @Test
    fun `fifo order preserved across reserve and commit`() {
        val q = OfflineQueue<String>(capacity = 5)
        q.enqueue("k1", "a")
        q.enqueue("k2", "b")
        val reserved = q.reserveDue(10, nowMs = 0)
        assertEquals(listOf("a", "b"), reserved.map { it.payload })
        q.commit(nowMs = 0, deliveredKeys = setOf("k1", "k2"))
        assertEquals(0, q.size())
    }

    @Test
    fun `duplicate key never double queued`() {
        val q = OfflineQueue<String>()
        assertTrue(q.enqueue("dup", "first"))
        assertFalse(q.enqueue("dup", "second"))
        assertEquals(1, q.size())
        assertEquals("first", q.snapshot().first().payload)
    }

    @Test
    fun `in flight key cannot be enqueued again`() {
        val q = OfflineQueue<String>()
        q.enqueue("dup", "first")
        q.reserveDue(10, nowMs = 0)
        assertFalse(q.enqueue("dup", "second"))
        assertEquals(1, q.size())
    }

    @Test
    fun `failed commit keeps entry and counts attempt`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "payload")
        q.reserveDue(10, nowMs = 100)
        q.commit(nowMs = 100, deliveredKeys = emptySet())
        assertEquals(1, q.size())
        val e = q.snapshot().first()
        assertEquals(1, e.attempts)
        assertEquals(100L, e.lastAttemptMs)
        assertEquals(100L + OfflineQueue.backoffFor(1), e.nextAttemptMs)
    }

    @Test
    fun `failed commit records error`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "payload")
        q.reserveDue(10, nowMs = 0)
        q.commit(nowMs = 0, deliveredKeys = emptySet(), error = "HTTP 500")
        assertEquals("HTTP 500", q.snapshot().first().lastError)
    }

    @Test
    fun `poisoned entry dropped after max attempts`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "bad")
        // v2.16.0: the backoff gate is REAL — each retry round must advance
        // the clock past the previous deadline (the drain loop does exactly
        // this in production; a flat nowMs would prove nothing).
        repeat(OfflineQueue.MAX_ATTEMPTS) { round ->
            val now = round * OfflineQueue.BACKOFF_MAX_MS
            q.reserveDue(10, nowMs = now)
            q.commit(nowMs = now, deliveredKeys = emptySet())
        }
        assertEquals(0, q.size())
    }

    @Test
    fun `backoff keeps a failing entry unreserved before its deadline`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "bad")
        q.reserveDue(10, nowMs = 0)
        q.commit(nowMs = 0, deliveredKeys = emptySet()) // attempts=1, due at +30s
        // Same-clock retries (the old drain behavior) must NOT happen now.
        assertTrue(q.reserveDue(10, nowMs = 0).isEmpty())
        assertEquals(1, q.size())
    }

    @Test
    fun `partial delivery removes only delivered keys`() {
        val q = OfflineQueue<String>()
        repeat(3) { q.enqueue("k$it", "p$it") }
        q.reserveDue(10, nowMs = 0)
        q.commit(nowMs = 0, deliveredKeys = setOf("k1"))
        assertEquals(listOf("k0", "k2"), q.snapshot().map { it.key })
    }

    @Test
    fun `reserve respects max per round and failures requeue in order`() {
        val q = OfflineQueue<String>()
        repeat(5) { q.enqueue("k$it", "p$it") }
        assertEquals(2, q.reserveDue(2, nowMs = 0).size)
        q.commit(nowMs = 0, deliveredKeys = emptySet())
        // Failures went back to the HEAD in reservation order — FIFO intact.
        assertEquals(listOf("k0", "k1", "k2", "k3", "k4"), q.snapshot().map { it.key })
    }

    @Test
    fun `backoff gates re-attempts until deadline passes`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "p")
        q.reserveDue(10, nowMs = 0)
        q.commit(nowMs = 0, deliveredKeys = emptySet())
        val backoff = OfflineQueue.backoffFor(1)
        // Backed off: nothing is due yet.
        assertTrue(q.reserveDue(10, nowMs = backoff - 1).isEmpty())
        // Deadline passed: due again.
        assertEquals(1, q.reserveDue(10, nowMs = backoff).size)
    }

    @Test
    fun `reserve cannot take the same entry twice`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "p")
        assertEquals(1, q.reserveDue(10, nowMs = 0).size)
        assertTrue(q.reserveDue(10, nowMs = 0).isEmpty())
        assertEquals(1, q.size()) // still owned by the sender
    }

    @Test
    fun `snapshot covers in flight entries — crash mid-send is recoverable`() {
        val q = OfflineQueue<String>()
        q.enqueue("k1", "a")
        q.enqueue("k2", "b")
        q.reserveDue(1, nowMs = 0) // k1 in flight, k2 waiting
        val snap = q.snapshot()
        assertEquals(listOf("k1", "k2"), snap.map { it.key })
        assertEquals(2, q.size())
        assertNull(snap.first().nextAttemptMs.takeIf { it != 0L })
    }

    @Test
    fun `commit with unknown keys is a no-op (idempotent)`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "p")
        q.reserveDue(10, nowMs = 0)
        q.commit(nowMs = 0, deliveredKeys = setOf("ghost"))
        assertEquals(1, q.size())
        assertEquals(1, q.snapshot().first().attempts)
    }

    @Test
    fun `commit on empty in flight is a no-op`() {
        val q = OfflineQueue<String>()
        q.commit(nowMs = 0, deliveredKeys = setOf("anything"))
        assertEquals(0, q.size())
    }

    @Test
    fun `backoffFor doubles and caps at ten minutes`() {
        assertEquals(0L, OfflineQueue.backoffFor(0))
        assertEquals(30_000L, OfflineQueue.backoffFor(1))
        assertEquals(60_000L, OfflineQueue.backoffFor(2))
        assertEquals(120_000L, OfflineQueue.backoffFor(3))
        assertEquals(OfflineQueue.BACKOFF_MAX_MS, OfflineQueue.backoffFor(6))
        // A hostile attempts value must not overflow the shift.
        assertEquals(OfflineQueue.BACKOFF_MAX_MS, OfflineQueue.backoffFor(Int.MAX_VALUE))
    }

    @Test
    fun `capacity eviction drops oldest attempted first and shields never-attempted`() {
        val q = OfflineQueue<String>(capacity = 3)
        q.enqueue("attempted-old", "old")
        // Mark it attempted (and give it an old lastAttempt timestamp).
        q.reserveDue(1, nowMs = 1_000)
        q.commit(nowMs = 1_000, deliveredKeys = emptySet())
        q.enqueue("fresh1", "f1")
        q.enqueue("fresh2", "f2")
        // Queue full: [attempted-old(attempted), fresh1, fresh2]. Admitting one more
        // must evict attempted-old, NOT the never-attempted fresh entries.
        q.enqueue("fresh3", "f3")
        val keys = q.snapshot().map { it.key }
        assertFalse(keys.contains("attempted-old"))
        assertEquals(listOf("fresh1", "fresh2", "fresh3"), keys)
    }

    // ------------------------
    // F1: restoreAll — cold-start survival contract
    // ------------------------

    @Test
    fun `restoreAll hydrates in order and drains after restore`() {
        val q = OfflineQueue<String>()
        q.restoreAll(
            listOf(
                OfflineQueue.Entry("k1", "a"),
                OfflineQueue.Entry("k2", "b"),
                OfflineQueue.Entry("k3", "c")
            )
        )
        assertEquals(3, q.size())
        val reserved = q.reserveDue(10, nowMs = 0)
        assertEquals(listOf("a", "b", "c"), reserved.map { it.payload })
        q.commit(nowMs = 0, deliveredKeys = setOf("k1", "k2", "k3"))
        assertEquals(0, q.size())
    }

    @Test
    fun `crash between reserve and commit is recovered by restoreAll`() {
        val q = OfflineQueue<String>()
        q.enqueue("k1", "a")
        q.enqueue("k2", "b")
        val persisted = q.snapshot() // what the app layer wrote just before reserve
        q.reserveDue(2, nowMs = 0)
        // --- process death: fresh queue, rehydrate from disk ---
        val q2 = OfflineQueue<String>()
        q2.restoreAll(persisted)
        assertEquals(2, q2.size())
        val reserved = q2.reserveDue(10, nowMs = 0)
        assertEquals(listOf("k1", "k2"), reserved.map { it.key })
        q2.commit(nowMs = 0, deliveredKeys = setOf("k1", "k2"))
        assertEquals(0, q2.size())
    }

    @Test
    fun `restoreAll dedupes by key keeping first occurrence order`() {
        val q = OfflineQueue<String>()
        q.restoreAll(
            listOf(
                OfflineQueue.Entry("dup", "first"),
                OfflineQueue.Entry("dup", "second"),
                OfflineQueue.Entry("other", "x")
            )
        )
        assertEquals(2, q.size())
        assertEquals(listOf("dup", "other"), q.snapshot().map { it.key })
        assertEquals("first", q.snapshot().first().payload)
    }

    @Test
    fun `restoreAll keeps attempt counts so poison state survives process death`() {
        val q = OfflineQueue<String>()
        val nearly = OfflineQueue.Entry("k", "bad", attempts = OfflineQueue.MAX_ATTEMPTS - 1)
        q.restoreAll(listOf(nearly))
        // One more failed round must POISON it — no fresh lives after restore.
        q.reserveDue(10, nowMs = 0)
        q.commit(nowMs = 0, deliveredKeys = emptySet())
        assertEquals(0, q.size())
    }

    @Test
    fun `restoreAll keeps backoff deadline so a dead endpoint is not retried instantly`() {
        val q = OfflineQueue<String>()
        val backed = OfflineQueue.Entry("k", "p", attempts = 2, nextAttemptMs = 123_456L)
        q.restoreAll(listOf(backed))
        assertTrue(q.reserveDue(10, nowMs = 123_455L).isEmpty())
        assertEquals(1, q.reserveDue(10, nowMs = 123_456L).size)
    }

    @Test
    fun `restoreAll caps at capacity keeping newest entries`() {
        val q = OfflineQueue<String>(capacity = 3)
        val entries = (0 until 5).map { OfflineQueue.Entry("k$it", "p$it") }
        q.restoreAll(entries)
        assertEquals(listOf("k2", "k3", "k4"), q.snapshot().map { it.key })
    }

    @Test
    fun `restoreAll on empty list yields empty queue`() {
        val q = OfflineQueue<String>()
        q.enqueue("stale", "x")
        q.restoreAll(emptyList())
        assertEquals(0, q.size())
    }
}
