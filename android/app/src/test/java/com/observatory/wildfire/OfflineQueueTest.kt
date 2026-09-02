package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineQueueTest {

    @Test
    fun `fifo order preserved`() {
        val q = OfflineQueue<String>(capacity = 5)
        q.enqueue("k1", "a")
        q.enqueue("k2", "b")
        val sent = mutableListOf<String>()
        q.drain(10, nowMs = 0) { sent.add(it); true }
        assertEquals(listOf("a", "b"), sent)
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
    fun `failed drain keeps entry and counts attempt`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "payload")
        assertEquals(0, q.drain(10, nowMs = 100) { false })
        assertEquals(1, q.size())
        assertEquals(1, q.snapshot().first().attempts)
    }

    @Test
    fun `poisoned entry dropped after max attempts`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "bad")
        repeat(OfflineQueue.MAX_ATTEMPTS) {
            q.drain(10, nowMs = 0) { false }
        }
        assertEquals(0, q.size())
    }

    @Test
    fun `drain respects max per round`() {
        val q = OfflineQueue<String>()
        repeat(5) { q.enqueue("k$it", "p$it") }
        assertEquals(2, q.drain(2, nowMs = 0) { true })
        assertEquals(3, q.size())
    }

    @Test
    fun `capacity eviction drops oldest attempted first and shields never-attempted`() {
        val q = OfflineQueue<String>(capacity = 3)
        q.enqueue("attempted-old", "old")
        // Mark it attempted (and give it an old lastAttempt timestamp).
        q.drain(1, nowMs = 1_000) { false }
        q.enqueue("fresh1", "f1")
        q.enqueue("fresh2", "f2")
        // Queue full: [attempted-old(attempted), fresh1, fresh2]. Admitting one more
        // must evict attempted-old, NOT the never-attempted fresh entries.
        q.enqueue("fresh3", "f3")
        val keys = q.snapshot().map { it.key }
        assertFalse(keys.contains("attempted-old"))
        assertEquals(listOf("fresh1", "fresh2", "fresh3"), keys)
    }

    @Test
    fun `send throwing counts as failure not crash`() {
        val q = OfflineQueue<String>()
        q.enqueue("k", "boom")
        assertEquals(0, q.drain(10, nowMs = 0) { throw IllegalStateException("transport") })
        assertEquals(1, q.size())
    }
}
