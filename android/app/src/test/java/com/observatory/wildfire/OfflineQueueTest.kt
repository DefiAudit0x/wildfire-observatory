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
        repeat(OfflineQueue.MAX_ATTEMPTS - 1) { round ->
            val now = round * OfflineQueue.BACKOFF_MAX_MS
            q.reserveDue(10, nowMs = now)
            q.commit(nowMs = now, deliveredKeys = emptySet())
        }
        // Seven real failures: still queued (attempts 7), not dropped early.
        assertEquals(1, q.size())
        assertEquals(OfflineQueue.MAX_ATTEMPTS - 1, q.snapshot().first().attempts)
        // The eighth failure poisons it.
        val now = (OfflineQueue.MAX_ATTEMPTS - 1) * OfflineQueue.BACKOFF_MAX_MS
        q.reserveDue(10, nowMs = now)
        q.commit(nowMs = now, deliveredKeys = emptySet())
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
        // Mark two entries attempted with different lastAttempt times:
        // attempted-old first (lastAttempt 1_000), attempted-new second
        // (lastAttempt 2_000). The second reserve skips attempted-old —
        // it is backed off to 31_000 — and takes attempted-new.
        q.enqueue("attempted-old", "old")
        q.reserveDue(1, nowMs = 1_000)
        q.commit(nowMs = 1_000, deliveredKeys = emptySet())
        q.enqueue("attempted-new", "new")
        q.reserveDue(1, nowMs = 1_000)
        q.commit(nowMs = 2_000, deliveredKeys = emptySet())
        q.enqueue("fresh0", "f0")
        // Queue full: [attempted-new(attempted, 2_000), attempted-old(attempted, 1_000), fresh0(never)].
        // Admitting one more must evict attempted-old — the OLDEST attempted
        // entry — not the head (attempted-new), not the newest attempted
        // entry, and not the never-attempted fresh0.
        q.enqueue("fresh3", "f3")
        val keys = q.snapshot().map { it.key }
        assertFalse(keys.contains("attempted-old"))
        assertEquals(listOf("attempted-new", "fresh0", "fresh3"), keys)
    }

    // ------------------------
    // Fix 50 (NOFF-1): the admission gate counts in-flight entries
    // ------------------------

    @Test
    fun `admission counts in-flight entries (finding)`() {
        val q = OfflineQueue<String>(capacity = 3)
        q.enqueue("k0", "p0")
        q.enqueue("k1", "p1")
        q.enqueue("k2", "p2")
        q.reserveDue(1, nowMs = 0) // k0 in flight: 2 waiting + 1 in flight
        q.enqueue("k3", "p3") // total is 3 — must evict a waiting entry
        assertEquals(3, q.size())
        // Victim is k1 (oldest waiting; both waiting entries are
        // never-attempted, so the ?: 0 fallback takes the head).
        assertEquals(listOf("k0", "k2", "k3"), q.snapshot().map { it.key })
    }

    @Test
    fun `failed commit cannot push waiting past capacity across drain cycles (finding)`() {
        val q = OfflineQueue<String>(capacity = 3)
        q.enqueue("k0", "p0")
        q.enqueue("k1", "p1")
        q.enqueue("k2", "p2")
        // Cycle 1: reserve k0, admit k3 (evicts k1), commit fails at 0
        // (k0 requeues, due again at +30s).
        q.reserveDue(1, nowMs = 0)
        q.enqueue("k3", "p3")
        q.commit(nowMs = 0, deliveredKeys = emptySet())
        assertEquals(3, q.size())
        // Cycle 2: reserve k0 (due at 30_000), admit k4 (evicts k2),
        // commit fails at 30_000 (k0 due again at +60s = 90_000).
        q.reserveDue(1, nowMs = 30_000)
        q.enqueue("k4", "p4")
        q.commit(nowMs = 30_000, deliveredKeys = emptySet())
        assertEquals(3, q.size())
        // Cycle 3: reserve k0 (due at 90_000), admit k5 (evicts k3),
        // commit fails at 90_000.
        q.reserveDue(1, nowMs = 90_000)
        q.enqueue("k5", "p5")
        q.commit(nowMs = 90_000, deliveredKeys = emptySet())
        assertEquals(3, q.size())
        assertEquals(listOf("k0", "k4", "k5"), q.snapshot().map { it.key })
    }

    @Test
    fun `admission below capacity with in-flight entries does not evict (control)`() {
        val q = OfflineQueue<String>(capacity = 3)
        q.enqueue("k0", "p0")
        q.enqueue("k1", "p1")
        q.reserveDue(1, nowMs = 0) // k0 in flight: 1 waiting + 1 in flight
        q.enqueue("k2", "p2") // total 2 < 3 — no eviction
        assertEquals(3, q.size())
        assertEquals(listOf("k0", "k1", "k2"), q.snapshot().map { it.key })
    }

    @Test
    fun `in-flight entries are never eviction candidates (control)`() {
        val q = OfflineQueue<String>(capacity = 3)
        q.enqueue("a0", "pa0")
        // Mark a0 attempted (next attempt due at 31_000).
        q.reserveDue(1, nowMs = 1_000)
        q.commit(nowMs = 1_000, deliveredKeys = emptySet())
        q.enqueue("f1", "pf1")
        q.enqueue("f2", "pf2")
        q.reserveDue(1, nowMs = 31_000) // a0 in flight again
        q.enqueue("f3", "pf3") // total is 3 — must evict a WAITING entry
        assertEquals(3, q.size())
        // Victim is f1 (waiting, never-attempted fallback); a0 survives
        // in flight — it was never a candidate.
        assertEquals(listOf("a0", "f2", "f3"), q.snapshot().map { it.key })
    }

    @Test
    fun `everything in flight admits without a crash (control)`() {
        val q = OfflineQueue<String>(capacity = 2)
        q.enqueue("k0", "p0")
        q.enqueue("k1", "p1")
        q.reserveDue(2, nowMs = 0) // both in flight, nothing waiting
        // Pins the empty-deque guard: with nothing waiting there is
        // nothing to evict, so admission must succeed (total 3 = 1 waiting
        // + 2 in flight — eviction is impossible here, and no current
        // caller can reach this state; the drain reserves at most 3 of 60).
        assertTrue(q.enqueue("k2", "p2"))
        assertEquals(3, q.size())
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
        // Restore must keep the entry AND its attempt history — a restore
        // that discarded it would pass the final empty assertion vacuously.
        assertEquals(1, q.size())
        assertEquals(OfflineQueue.MAX_ATTEMPTS - 1, q.snapshot().first().attempts)
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

    // ---------- Fix 18 (NREP-5): selectPersistable ----------

    private fun entry(key: String, payloadChars: Int) =
        OfflineQueue.Entry(key, "x".repeat(payloadChars))

    @Test
    fun `a full queue of max-size SOS payloads fits the new 48M budget`() {
        val entries = (0 until 60).map { entry("k$it", 700_000) }
        val (persisted, omitted) = OfflineQueue.selectPersistable(entries, 800_000, 48_000_000)
        assertEquals(60, persisted.size)
        assertEquals(0, omitted)
    }

    @Test
    fun `the old 12M budget dropped most of a full max-size queue`() {
        // Fail-without-fix shape: 60 × 700k = 42M chars; the old budget
        // held 17 entries and silently dropped the 43 newest emergencies.
        val entries = (0 until 60).map { entry("k$it", 700_000) }
        val (persisted, omitted) = OfflineQueue.selectPersistable(entries, 800_000, 12_000_000)
        assertEquals(17, persisted.size)
        assertEquals(43, omitted)
        assertEquals((0 until 17).map { "k$it" }, persisted.map { it.key })
    }

    @Test
    fun `one oversized entry is omitted and the rest persist`() {
        val entries = listOf(entry("k1", 10), entry("k2", 900_000), entry("k3", 10))
        val (persisted, omitted) = OfflineQueue.selectPersistable(entries, 800_000, 48_000_000)
        assertEquals(listOf("k1", "k3"), persisted.map { it.key })
        assertEquals(1, omitted)
    }

    @Test
    fun `over the total budget only the newest tail is omitted`() {
        val entries = listOf(entry("k1", 100), entry("k2", 100), entry("k3", 100))
        val (persisted, omitted) = OfflineQueue.selectPersistable(entries, 800_000, 250)
        assertEquals(listOf("k1", "k2"), persisted.map { it.key })
        assertEquals(1, omitted)
    }

    @Test
    fun `empty list persists nothing and omits nothing`() {
        val (persisted, omitted) = OfflineQueue.selectPersistable(emptyList(), 800_000, 48_000_000)
        assertEquals(0, persisted.size)
        assertEquals(0, omitted)
    }

    @Test
    fun `an entry exactly at the budget boundary persists, one char over does not`() {
        val at = listOf(entry("k1", 1_000))
        val (persistedAt, omittedAt) = OfflineQueue.selectPersistable(at, 800_000, 1_000)
        assertEquals(1, persistedAt.size)
        assertEquals(0, omittedAt)
        val over = listOf(entry("k1", 1_001))
        val (persistedOver, omittedOver) = OfflineQueue.selectPersistable(over, 800_000, 1_000)
        assertEquals(0, persistedOver.size)
        assertEquals(1, omittedOver)
    }
}
