package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ARC-H16 pinning specs for the transport registry extracted from
 * MeshService. Pinned here: UPSERT registration (a re-announcement with a
 * rotated key refreshes the CURRENT key — audit round 12), lastSeen = max,
 * the 1s debounced touch, the connected/fresh candidate filter for the
 * trickle tick, and the registry slice of the unified peer-gone teardown.
 */
class MeshPeerRegistryTest {

    @Test
    fun registerCreatesThenUpsertsKeyAndKeepsFreshestLastSeen() {
        val r = MeshPeerRegistry()
        r.register("ep1", "KEY_A", now = 1000L)
        assertEquals("KEY_A", r.peers["ep1"]!!.publicKey)
        assertEquals(1000L, r.peers["ep1"]!!.lastSeen)

        // A rotated key + re-announce refreshes the CURRENT key (putIfAbsent
        // would have kept the stale one — the exact bug audit round 12 fixed).
        r.register("ep1", "KEY_B", now = 2000L)
        assertEquals("KEY_B", r.peers["ep1"]!!.publicKey)
        assertEquals(2000L, r.peers["ep1"]!!.lastSeen)

        // A sighting with an EARLIER clock never rolls lastSeen back.
        r.register("ep1", "KEY_B", now = 1500L)
        assertEquals(2000L, r.peers["ep1"]!!.lastSeen)
    }

    @Test
    fun touchIsDebouncedToOneSecond() {
        val r = MeshPeerRegistry()
        r.register("ep1", "KEY_A", now = 1000L)
        r.touch("ep1", now = 1500L) // 500ms — under the debounce
        assertEquals(1000L, r.peers["ep1"]!!.lastSeen)
        r.touch("ep1", now = 2001L) // 1001ms — over the debounce
        assertEquals(2001L, r.peers["ep1"]!!.lastSeen)
        r.touch("unknown-ep", now = 9_000L) // no-op, no crash
    }

    @Test
    fun knownKeyReturnsRegisteredKeyOrNull() {
        val r = MeshPeerRegistry()
        assertNull(r.knownKey("ep1"))
        r.register("ep1", "KEY_A", now = 1L)
        assertEquals("KEY_A", r.knownKey("ep1"))
    }

    @Test
    fun connectedFreshCandidatesRequireConnectedAndFresh() {
        val r = MeshPeerRegistry()
        val now = MeshQueue.MESSAGE_TTL_MS // any stable "now"
        r.register("fresh-connected", "K1", now = now)
        r.register("stale-connected", "K2", now = now - MeshPeerRegistry.PEER_STALE_MS)
        r.register("fresh-connecting", "K3", now = now)
        r.connectedPeers.add("fresh-connected")
        r.connectedPeers.add("stale-connected")
        r.connectingPeers.add("fresh-connecting")

        val candidates = r.connectedFreshCandidates(now)

        assertTrue(candidates.containsKey("fresh-connected"))
        // Stale boundary is exclusive (`now - lastSeen < PEER_STALE_MS`): a
        // peer at EXACTLY the staleness limit is not a candidate.
        assertFalse(candidates.containsKey("stale-connected"))
        assertFalse(candidates.containsKey("fresh-connecting"))
    }

    @Test
    fun connectedSnapshotExposesOnlyEstablishedConnections() {
        val r = MeshPeerRegistry()
        r.register("ep1", "K1", now = 1L)
        r.register("ep2", "K2", now = 2L)
        r.connectedPeers.add("ep1")
        // ep2 registered (discovery) but still connecting.

        val snapshot = r.connectedSnapshot()
        assertEquals(listOf("ep1"), snapshot.map { it.first })
        assertEquals("K1", snapshot.first().second.publicKey)
    }

    @Test
    fun forgetClearsPeerAndHandshakeDedupeFlags() {
        val r = MeshPeerRegistry()
        r.register("ep1", "KEY_A", now = 1L)
        r.connectingPeers.add("ep1")
        r.connectedPeers.add("ep1")

        r.forget("ep1")

        assertNull(r.peers["ep1"])
        assertFalse(r.connectingPeers.contains("ep1"))
        assertFalse(r.connectedPeers.contains("ep1"))
    }
}
