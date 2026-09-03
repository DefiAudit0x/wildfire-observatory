package com.observatory.wildfire

import java.util.concurrent.ConcurrentHashMap

/**
 * ARC-H16: transport registry extracted from MeshService as a PURE JVM
 * module (no Android imports — unit-tested in MeshPeerRegistryTest). Owns
 * the endpointId -> EndpointInfo map and the connection state machine's
 * dedupe sets. The SERVICE keeps the admission gates (shape gate +
 * CryptoEngine SPKI decode) and every Nearby call — this module never
 * touches the transport.
 */
class MeshPeerRegistry {

    companion object {
        // ARC-L24: named (was an inline 300_000L in the tick candidate filter).
        // A peer unseen for this long is not a send candidate.
        const val PEER_STALE_MS = 10 * 60 * 1000L
    }

    // Known peers: endpointId -> EndpointInfo (transport registry; the
    // identity/reputation anchor is the public key — see MeshReputation).
    // Audit round 12: the old EndpointInfo.ephemeralId ("unknown" forever)
    // and hopCount fields were removed — they were never populated from a
    // real source, and a misleading "identity-looking" field invites future
    // misuse. hop state lives on MeshMessage/wire frames only.
    data class EndpointInfo(
        val endpointId: String,
        val publicKey: String,
        var lastSeen: Long
    )

    val peers = ConcurrentHashMap<String, EndpointInfo>()

    // Connection state machine (audit A4): Nearby re-fires onEndpointFound
    // repeatedly while discovery is active. Tracking pending + established
    // connections here means one requestConnection per endpoint — no duplicate
    // handshakes, no reconnect storms while a session is already in flight.
    val connectingPeers = ConcurrentHashMap.newKeySet<String>()
    val connectedPeers = ConcurrentHashMap.newKeySet<String>()

    /**
     * Register (or refresh) a transport handle. UPSERT semantics (audit round
     * 12): the old putIfAbsent kept the FIRST key seen for an endpointId —
     * after a peer rotated its ephemeral key and re-announced, the registry
     * kept encrypting to the STALE key. Every sighting (discovery,
     * connection-initiated, connection-result) refreshes the CURRENT key.
     * The caller runs the identity validation gate BEFORE calling this
     * (shape + SPKI decode), so everything that lands here is trusted.
     */
    fun register(endpointId: String, publicKey: String, now: Long) {
        val existing = peers[endpointId]
        val lastSeen = if (existing != null) maxOf(existing.lastSeen, now) else now
        peers[endpointId] = EndpointInfo(endpointId = endpointId, publicKey = publicKey, lastSeen = lastSeen)
    }

    /**
     * Keep the sender fresh: a peer that receives from us but is quiet
     * (relay-only) must not go stale (audit round 11: lastSeen was only
     * advanced on connection, so 10 minutes of one-way traffic made us stop
     * sending to an active neighbor). Debounced to 1s (verbatim threshold).
     */
    fun touch(endpointId: String, now: Long) {
        peers[endpointId]?.let { info ->
            if (now - info.lastSeen > 1000) {
                peers[endpointId] = info.copy(lastSeen = now)
            }
        }
    }

    /** The public key a transport handle is registered with (null when unknown). */
    fun knownKey(endpointId: String): String? = peers[endpointId]?.publicKey

    /** Registry slice of the unified peer-gone teardown (audit round 12). */
    fun forget(endpointId: String) {
        peers.remove(endpointId)
        // Audit A4: every teardown path (lost/disconnect/failed/quarantine)
        // also clears the handshake dedupe flags.
        connectingPeers.remove(endpointId)
        connectedPeers.remove(endpointId)
    }

    /**
     * Tick candidates, registry slice: connected AND seen within
     * [PEER_STALE_MS]. The service filters these further by reputation
     * admission and the per-message forwarded marker.
     */
    fun connectedFreshCandidates(now: Long): Map<String, EndpointInfo> =
        peers.filter { (id, info) ->
            connectedPeers.contains(id) && now - info.lastSeen < PEER_STALE_MS
        }

    /**
     * ARC-L24: `peers` is populated at DISCOVERY time (register runs from
     * onEndpointFound, before requestConnection completes), so mapping it
     * whole reported still-CONNECTING endpoints as connected to the UI.
     * Filter to the ACTUALLY-connected set.
     */
    fun connectedSnapshot(): List<Pair<String, EndpointInfo>> =
        peers.filterKeys { connectedPeers.contains(it) }.map { (id, info) -> id to info }
}
