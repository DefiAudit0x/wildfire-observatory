package com.observatory.wildfire

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * ARC-H16: store-and-forward queue + delivery bookkeeping extracted from
 * MeshService as a PURE JVM module (no Android imports — unit-tested in
 * MeshQueueTest). Owns the bounded pending queue, the send-attempt dedup
 * markers, the in-flight payload bindings and the delivered-target sets —
 * all clock-driven state with [now] passed in by the caller so every
 * policy here is deterministic and testable.
 *
 * The SERVICE composes this with the peer registry and executes the actual
 * Nearby transport sends — this module never touches the transport.
 */
class MeshQueue {

    companion object {
        // Store-and-forward hygiene: a queued message lives at most 10 minutes
        // since its LAST delivery attempt — never since it was queued, so a
        // message that waited for peers is not penalized for time it could not
        // act — and the queue is capped so an idle mesh can never grow
        // unbounded. Messages that were NEVER attempted (no peer in range)
        // wait indefinitely and are only evicted by the queue cap.
        // (Audit round 12: the old MESSAGE_TTL_WINDOWS delivery budget was
        // removed — 3 trickle windows expired messages in well under a minute
        // even when every attempt was retryable, making the stated 10-minute
        // TTL a lie. Expiry is now purely time-based.)
        const val MESSAGE_TTL_MS = 10 * 60 * 1000L
        // ARC-L24: named (was an inline 300_000L). Forwarded markers expire
        // 5 minutes after their last delivery attempt so a peer that dropped
        // out can accept a re-send when it returns.
        const val FORWARDED_MARKER_TTL_MS = 300_000L

        // H1 fix: the relay path must respect the same queue bound as
        // broadcastMessage — otherwise a peer flooding unique valid
        // frames grows pendingMessages without limit (OOM on a device
        // that must stay alive for an emergency).
        const val MAX_PENDING_MESSAGES = 200
    }

    // Message queue for Trickle algorithm — ciphertext + IV are relayed verbatim
    // so intermediate nodes never see plaintext. The wire identity of a message
    // (nonce, coordinates, sender timestamp/signature) travels unchanged across
    // every hop; only hopsLeft decays (hopCount is SIGNED and immutable — see
    // MeshWire).
    data class MeshMessage(
        val messageId: String,
        val type: String,
        val payloadB64: String,
        val iv: String,
        val hopCount: Int,
        val hopsLeft: Int,
        val origEphemeralId: String,
        val origPublicKey: String,
        val timestamp: Long,
        val signature: String,
        val nonce: Int,
        val lat: Double,
        val lng: Double,
        val powNonce: Int,
        val powDifficulty: Int,
        // The exact ephemeral material this message was (or will be) signed
        // and encrypted with (audit round 11): the PoW prefix, origEphemeralId,
        // origPublicKey and the E2EE signature must ALL derive from ONE
        // snapshot, otherwise rotation between reads yields a frame every
        // peer rejects. Locally generated messages carry the snapshot; relayed
        // messages carry null and re-emit the stored frame verbatim.
        //
        // Audit round 12: this is the SHARED immutable key-generation handle
        // — every queued message of one generation references the SAME
        // instance (no per-message key material copies). Memory per queued
        // message is three references, and the 1h rotation period dwarfs the
        // 10-minute message TTL, so the bounded queue can hold at most two
        // generations at once. The snapshot keeps working after rotation —
        // signing/encrypting with a retired sender key is valid because the
        // frame carries that generation's id+pubkey and the signature is
        // verified against them.
        val snapshot: CryptoEngine.EphemeralSnapshot? = null,
        // Delivery bookkeeping. Expiry is TIME-BASED since the last actual
        // send (audit round 12: the old per-window attempt budget expired
        // messages in seconds even when every attempt stayed retryable).
        // lastSendAttemptAt anchors the clock; 0 means "never sent to
        // anyone" (such messages wait indefinitely, evicted only by the
        // queue cap — store-and-forward semantics).
        var lastSendAttemptAt: Long = 0L,
        // Endpoints this message was actually handed to the transport for
        // (one frame per endpoint). Delivery ACKs arrive via
        // onPayloadTransferUpdate; a message whose every attempted endpoint
        // acknowledged delivery can be evicted early. Failed/canceled
        // transfers REMOVE their endpoint so the eviction check above never
        // counts a failed attempt as "delivered pending" (audit round 11).
        val attemptedTargets: MutableSet<String> = ConcurrentHashMap.newKeySet(),
        // Real in-flight guard (audit round 11): checked in trickleTick's
        // batch selection and cleared in a finally block. The old field was
        // only ever SET and never READ — a marker, not a guard; now a message
        // currently inside a send loop cannot be picked up by a concurrent
        // tick (defense in depth against a future async send path).
        var inFlight: Boolean = false,
        // Locally generated messages are queued as plaintext and encrypted
        // SEPARATELY FOR EACH target peer at send time — the ciphertext is
        // never shared between recipients.
        val needsEncryption: Boolean = false,
        val plaintext: String = ""
    )

    // Send-attempt dedup markers: "the same frame was handed to the transport
    // for this peer at time t". These are NOT delivery acknowledgements —
    // delivery is accounted separately in deliveredTargets.
    val forwardedMessages = ConcurrentHashMap<String, Long>()

    // Nearby payload id -> (endpointId, mesh messageId): lets
    // onPayloadTransferUpdate attribute an outgoing transfer outcome to its
    // mesh message AND lets peer-cleanup drop mappings whose endpoint is
    // gone (audit round 12 — the mapping used to be endpoint-agnostic, so a
    // peer vanishing without a final transfer callback leaked the entry).
    data class PayloadBinding(val endpointId: String, val messageId: String)
    val payloadToMessage = ConcurrentHashMap<Long, PayloadBinding>()

    // messageId -> set of endpointIds whose transfer acknowledged SUCCESS.
    // Only this set counts as "delivered" (sendPayload ≠ delivery).
    val deliveredTargets = ConcurrentHashMap<String, MutableSet<String>>()

    val pending = CopyOnWriteArrayList<MeshMessage>()

    /**
     * H1 fix: single eviction policy shared by the local broadcast and relay
     * paths. Entries that have never been sent to anyone (no reachable peers
     * yet) are shielded from eviction — they carry the newest reports and
     * would otherwise be the first to die under load. Already-attempted
     * entries go first (their 10-minute clock is ordered by lastSendAttemptAt).
     */
    fun evictIfFull() {
        if (pending.size < MAX_PENDING_MESSAGES) return
        val evictable = pending
            .withIndex()
            .filter { it.value.lastSendAttemptAt > 0 }
            .minByOrNull { it.value.lastSendAttemptAt }
        if (evictable != null) {
            pending.removeAt(evictable.index)
        } else {
            // Everything is un-attempted and alive: drop the oldest
            // entry to keep the queue bounded.
            if (pending.isNotEmpty()) {
                pending.removeAt(0)
            }
        }
    }

    /**
     * Store-and-forward hygiene FIRST (audit round 12): the old code ran
     * this AFTER the batch-empty early return, so an idle queue (empty
     * batch) skipped the whole cleanup — stale sees, forwarded markers,
     * delivered sets and payload bindings lived far past their TTL.
     * Expiry is TIME-BASED since the LAST SEND (audit round 12): the old
     * per-window attempt budget died in seconds; a message now burns its
     * 10-minute clock only when delivery was actually attempted, and a
     * message whose every attempted target delivered is evicted early.
     * Never-attempted messages (no peer in range) wait indefinitely —
     * bounded by the queue cap — because they could not act.
     *
     * Called by the service's trickle tick BEFORE the replay-window sweep
     * and the marker sweep, preserving the original cleanup order.
     */
    fun sweepExpiredMessages(now: Long) {
        val cutoff = now - MESSAGE_TTL_MS
        pending.removeAll { msg ->
            (msg.lastSendAttemptAt > 0 && msg.lastSendAttemptAt < cutoff) ||
                (msg.attemptedTargets.isNotEmpty() &&
                    msg.attemptedTargets.all { ep -> deliveredTargets[msg.messageId]?.contains(ep) == true })
        }
    }

    /**
     * ARC-L24: forwarded markers expire (FORWARDED_MARKER_TTL_MS) after their
     * last delivery attempt so a peer that dropped out can accept a re-send
     * when it returns. Then the bookkeeping maps are pruned against the live
     * queue: delivery sets for evicted messages can go; in-flight mapping
     * entries for gone messages too (bounded by payloads actually in flight).
     */
    fun sweepMarkers(now: Long) {
        forwardedMessages.entries.removeAll { it.value < now - FORWARDED_MARKER_TTL_MS }
        val liveMessageIds = pending.map { it.messageId }.toSet()
        deliveredTargets.keys.retainAll(liveMessageIds)
        payloadToMessage.entries.removeAll { (_, binding) -> binding.messageId !in liveMessageIds }
    }

    /**
     * Trickle-K with O(F) counting (audit round 12): the old batch filter
     * ran a full forwardedMessages scan PER queued message — O(M×F) per
     * tick, quadratic in the mesh size. Count forwards ONCE into a small
     * map (O(F)), then filter in O(M). Only markers inside the caller's
     * window ([windowMs], the live trickle interval) are counted.
     */
    fun forwardsInWindow(now: Long, windowMs: Long): Map<String, Int> {
        val forwardsPerMessage = HashMap<String, Int>()
        for ((key, ts) in forwardedMessages) {
            if (now - ts >= windowMs) continue
            val sep = key.indexOf(':')
            if (sep <= 0 || sep == key.length - 1) continue
            forwardsPerMessage.merge(key.substring(sep + 1), 1, Int::plus)
        }
        return forwardsPerMessage
    }

    /** Per-target send marker (verbatim: `forwardedMessages["$endpointId:$messageId"] = now`). */
    fun markForwarded(endpointId: String, messageId: String, now: Long) {
        forwardedMessages["$endpointId:$messageId"] = now
    }

    /** Retry gate used by the tick's candidate filter (verbatim containsKey). */
    fun isForwarded(endpointId: String, messageId: String): Boolean =
        forwardedMessages.containsKey("$endpointId:$messageId")

    /** Bind an outgoing Nearby payload id to its (endpoint, message) pair (verbatim sendToTarget). */
    fun bindOutgoing(payloadId: Long, endpointId: String, messageId: String) {
        payloadToMessage[payloadId] = PayloadBinding(endpointId = endpointId, messageId = messageId)
    }

    /**
     * Unified session-bound teardown, queue slice (audit round 12): EVERY
     * peer-gone event drops the forwarded markers (retry gate), the in-flight
     * payload bindings (with no final transfer callback, the old code leaked
     * the mapping), the per-message attempted-target set and the delivered
     * set for that endpoint.
     */
    fun onPeerGone(endpointId: String) {
        forwardedMessages.keys.removeAll { it.startsWith("$endpointId:") }
        payloadToMessage.entries.removeAll { (_, binding) -> binding.endpointId == endpointId }
        // A vanished peer can never deliver: drop it from every message's
        // attempted/delivered bookkeeping so those messages stay re-openable.
        pending.forEach { it.attemptedTargets.remove(endpointId) }
        deliveredTargets.values.forEach { it.remove(endpointId) }
    }
}
