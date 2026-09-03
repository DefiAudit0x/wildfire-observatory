package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ARC-H16 pinning specs for the store-and-forward queue extracted from
 * MeshService. Every policy that used to live inline in the god-component
 * is pinned here so the extraction cannot silently drift:
 *  - the H1 eviction shield (never-attempted messages outlive attempted ones)
 *  - time-based TTL since the LAST SEND (never-attempted never expires)
 *  - all-delivered early eviction
 *  - forwarded-marker TTL sweep + O(F) in-window counting with malformed keys
 *  - the queue slice of the unified peer-gone teardown
 */
class MeshQueueTest {

    private fun msg(
        messageId: String,
        lastSendAttemptAt: Long = 0L,
        attempted: Set<String> = emptySet()
    ): MeshQueue.MeshMessage =
        MeshQueue.MeshMessage(
            messageId = messageId,
            type = "report",
            payloadB64 = "cGF5bG9hZA==",
            iv = "aXZpdml2",
            hopCount = 0,
            hopsLeft = MeshWire.MAX_HOPS,
            origEphemeralId = "eph",
            origPublicKey = "cHVia2V5",
            timestamp = 1000L,
            signature = "c2ln",
            nonce = 1,
            lat = 0.0,
            lng = 0.0,
            powNonce = 0,
            powDifficulty = MeshWire.NETWORK_POW_DIFFICULTY,
            lastSendAttemptAt = lastSendAttemptAt
        ).also { attempted.forEach { ep -> it.attemptedTargets.add(ep) } }

    private fun fill(queue: MeshQueue, count: Int, firstId: Int = 0, attemptBase: Long = 0L): Unit {
        repeat(count) { i ->
            queue.pending.add(
                msg(
                    "m${firstId + i}",
                    lastSendAttemptAt = if (attemptBase == 0L) 0L else attemptBase + i
                )
            )
        }
    }

    // ---- eviction ----

    @Test
    fun evictUnderCapIsNoOp() {
        val q = MeshQueue()
        fill(q, MeshQueue.MAX_PENDING_MESSAGES - 1, attemptBase = 100L)
        q.evictIfFull()
        assertEquals(MeshQueue.MAX_PENDING_MESSAGES - 1, q.pending.size)
    }

    @Test
    fun evictDropsOldestAttemptedFirst() {
        val q = MeshQueue()
        fill(q, MeshQueue.MAX_PENDING_MESSAGES, attemptBase = 100L) // attempts 100..299
        q.evictIfFull()
        assertEquals(MeshQueue.MAX_PENDING_MESSAGES - 1, q.pending.size)
        assertFalse(q.pending.any { it.messageId == "m0" }) // oldest attempt gone
        assertTrue(q.pending.any { it.messageId == "m${MeshQueue.MAX_PENDING_MESSAGES - 1}" })
    }

    @Test
    fun evictShieldsNeverAttemptedEvenWhenOlder() {
        val q = MeshQueue()
        // 199 never-attempted (shielded) + 1 attempted with a recent clock.
        fill(q, MeshQueue.MAX_PENDING_MESSAGES - 1)
        q.pending.add(msg("attempted", lastSendAttemptAt = Long.MAX_VALUE / 2))
        q.evictIfFull()
        assertEquals(MeshQueue.MAX_PENDING_MESSAGES - 1, q.pending.size)
        assertFalse(q.pending.any { it.messageId == "attempted" })
    }

    @Test
    fun evictFallsBackToOldestPositionWhenAllUnattempted() {
        val q = MeshQueue()
        fill(q, MeshQueue.MAX_PENDING_MESSAGES) // all lastSendAttemptAt == 0
        q.evictIfFull()
        assertEquals(MeshQueue.MAX_PENDING_MESSAGES - 1, q.pending.size)
        assertFalse(q.pending.any { it.messageId == "m0" }) // queue head dropped
    }

    // ---- TTL sweep ----

    @Test
    fun expiredSinceLastSendIsSwept() {
        val q = MeshQueue()
        val now = 1_000_000L
        q.pending.add(msg("dead", lastSendAttemptAt = now - MeshQueue.MESSAGE_TTL_MS - 1))
        q.pending.add(msg("alive", lastSendAttemptAt = now - MeshQueue.MESSAGE_TTL_MS + 1))
        q.sweepExpiredMessages(now)
        assertEquals(listOf("alive"), q.pending.map { it.messageId })
    }

    @Test
    fun neverAttemptedNeverExpiresRegardlessOfAge() {
        val q = MeshQueue()
        val ancient = msg("ancient", lastSendAttemptAt = 0L)
        q.pending.add(ancient)
        q.sweepExpiredMessages(Long.MAX_VALUE / 2)
        assertEquals(1, q.pending.size)
    }

    @Test
    fun allDeliveredMessageIsEvictedEarly() {
        val q = MeshQueue()
        val now = 1_000_000L
        val done = msg("done", lastSendAttemptAt = now, attempted = setOf("ep1"))
        val partial = msg("partial", lastSendAttemptAt = now, attempted = setOf("ep1", "ep2"))
        q.pending.add(done)
        q.pending.add(partial)
        q.deliveredTargets.getOrPut("done") { java.util.concurrent.ConcurrentHashMap.newKeySet() }.add("ep1")
        q.deliveredTargets.getOrPut("partial") { java.util.concurrent.ConcurrentHashMap.newKeySet() }.add("ep1")
        q.sweepExpiredMessages(now)
        // "done": every attempted target delivered → evicted despite a fresh clock.
        // "partial": ep2 never delivered → kept.
        assertEquals(listOf("partial"), q.pending.map { it.messageId })
    }

    // ---- marker sweep / bookkeeping pruning ----

    @Test
    fun staleForwardedMarkersSweptAndBookkeepingPruned() {
        val q = MeshQueue()
        val now = 1_000_000L
        q.pending.add(msg("live"))
        // "gone" is NOT in the pending queue — it simulates a message already
        // evicted by the TTL sweep whose bookkeeping must now be pruned.
        q.forwardedMessages["ep1:live"] = now - MeshQueue.FORWARDED_MARKER_TTL_MS + 1
        q.forwardedMessages["ep1:stale"] = now - MeshQueue.FORWARDED_MARKER_TTL_MS - 1
        q.deliveredTargets.getOrPut("live") { java.util.concurrent.ConcurrentHashMap.newKeySet() }.add("ep1")
        q.deliveredTargets.getOrPut("gone") { java.util.concurrent.ConcurrentHashMap.newKeySet() }.add("ep1")
        q.bindOutgoing(42L, "ep1", "live")
        q.bindOutgoing(43L, "ep1", "gone")

        q.sweepMarkers(now)

        assertFalse(q.forwardedMessages.containsKey("ep1:stale"))
        assertTrue(q.forwardedMessages.containsKey("ep1:live"))
        assertTrue(q.deliveredTargets.containsKey("live"))
        assertFalse(q.deliveredTargets.containsKey("gone"))
        assertNull(q.payloadToMessage[43L])
        assertEquals("live", q.payloadToMessage[42L]?.messageId)
    }

    // ---- in-window forward counting (O(F) trickle-K input) ----

    @Test
    fun forwardsInWindowCountsOnlyInsideWindowAndWellFormedKeys() {
        val q = MeshQueue()
        val now = 100_000L
        val window = 5_000L
        q.forwardedMessages["ep1:msgA"] = now - window + 1 // in window
        q.forwardedMessages["ep2:msgA"] = now - 1          // in window
        q.forwardedMessages["ep3:msgA"] = now - window     // boundary: excluded (now-ts >= window)
        q.forwardedMessages["ep4:msgB"] = now - window + 1 // in window
        q.forwardedMessages[":msgC"] = now - 1             // sep == 0 → malformed, skipped
        q.forwardedMessages["ep5:"] = now - 1              // sep == len-1 → malformed, skipped
        q.forwardedMessages["noColon"] = now - 1           // no separator → skipped

        val counts = q.forwardsInWindow(now, window)

        assertEquals(2, counts["msgA"])
        assertEquals(1, counts["msgB"])
        assertFalse(counts.containsKey("msgC"))
        assertFalse(counts.containsKey(""))
    }

    @Test
    fun markAndIsForwardedRoundTrip() {
        val q = MeshQueue()
        assertFalse(q.isForwarded("ep1", "msgA"))
        q.markForwarded("ep1", "msgA", 123L)
        assertTrue(q.isForwarded("ep1", "msgA"))
        assertEquals(123L, q.forwardedMessages["ep1:msgA"])
    }

    // ---- peer-gone teardown (queue slice) ----

    @Test
    fun onPeerGoneDropsOnlyThatEndpointsBookkeeping() {
        val q = MeshQueue()
        val m1 = msg("m1", attempted = setOf("ep1", "ep2"))
        q.pending.add(m1)
        q.markForwarded("ep1", "m1", 1L)
        q.markForwarded("ep2", "m1", 1L)
        q.bindOutgoing(7L, "ep1", "m1")
        q.bindOutgoing(8L, "ep2", "m1")
        q.deliveredTargets.getOrPut("m1") { java.util.concurrent.ConcurrentHashMap.newKeySet() }.apply {
            add("ep1"); add("ep2")
        }

        q.onPeerGone("ep1")

        assertFalse(q.isForwarded("ep1", "m1"))
        assertTrue(q.isForwarded("ep2", "m1"))
        assertNull(q.payloadToMessage[7L])
        assertEquals("m1", q.payloadToMessage[8L]?.messageId)
        assertFalse(m1.attemptedTargets.contains("ep1"))
        assertTrue(m1.attemptedTargets.contains("ep2"))
        assertFalse(q.deliveredTargets["m1"]!!.contains("ep1"))
        assertTrue(q.deliveredTargets["m1"]!!.contains("ep2"))
    }
}
