package com.observatory.wildfire

import java.util.concurrent.ConcurrentHashMap

/**
 * ARC-H16: the inbound authentication pipeline extracted from MeshService
 * as a PURE JVM module — unit-tested in MeshInboundTest with INJECTED
 * signature/decrypt lambdas (the service wires the real CryptoEngine calls;
 * the tests wire JVM stand-ins, so the whole gate chain is pinned without
 * any Android crypto dependency).
 *
 * The module owns the ORDER of the gates and the anti-replay seen-cache.
 * The SERVICE owns the logging strings, the reputation penalties (driven by
 * the verdict), the peer touch, the relay enqueue and listener dispatch —
 * executed in exactly the original handleIncomingMessage order.
 */
class MeshInbound(
    // ECDSA verification over the canonical signed metadata — wired to
    // CryptoEngine.verifyMessageSignature by the service.
    private val verifySignature: (CryptoEngine.SecureMessage) -> Boolean,
    // E2EE decryption for frames addressed to this device — wired to
    // CryptoEngine.decryptFromPeer by the service. Null = not addressed
    // to us (relayed E2EE), which must NEVER be punished.
    private val decrypt: (CryptoEngine.SecureMessage) -> ByteArray?
) {

    companion object {
        // Wire message types (service companion keeps readable aliases).
        // NOTE (audit round 12): MESSAGE_TYPE_REPUTATION was removed. It was
        // whitelisted in the bridge but had NO wire protocol handling — the
        // receiver has no reputation branch, so advertising a type nothing
        // processes is a dead + misleading protocol surface. Reputation is
        // scored from authenticated traffic (reports/echoes) only.
        const val TYPE_REPORT = "report"
        const val TYPE_ECHO = "echo"

        // Seen-hash cache bound (audit): the 5-minute TTL limits LIFETIME but
        // not SIZE — an attacker flooding unique garbage could grow the map
        // unbounded in the window. The cap evicts the OLDEST entry as soon as
        // it is exceeded (see evaluate / the tick's safety net).
        //
        // Threat budget (audit round 12 — why 4096): entries are only added
        // AFTER full authentication (PoW + ECDSA), so the cache grows at the
        // rate of VALID traffic. 4096 spans ~13.6 verified messages/second
        // across the whole 5-minute window — far beyond the capacity of a
        // battery-powered P2P cluster — so eviction under normal operation
        // never shrinks the effective replay window. The residual trade-off:
        // an authenticated flooding sender can truncate the replay window by
        // outrunning the cap — the cap caps MEMORY, not the replay policy.
        const val MAX_SEEN_HASHES = 4096

        // Echo messages are plaintext hop counters by design — but they are
        // SIGNED like every other frame. The original decode used
        // android.util.Base64 (NO_WRAP); this module is pure JVM, so the
        // platform-neutral RFC 4648 decoder is used instead. For every frame
        // the mesh itself produces (NO_WRAP encoding, no line separators)
        // the output is byte-identical; malformed input throws
        // IllegalArgumentException exactly like the Android decoder did,
        // which the caller's catch-all contains (frame dropped, no penalty).
    }

    // Anti-replay lives in seenMessageHashes (messageId + nonce) — see
    // evaluate. A nonce-only set would reject legitimately
    // distinct messages from a fast sender.
    val seenMessageHashes = ConcurrentHashMap<String, Long>()

    /** Why a frame was rejected — the service maps these to the ORIGINAL log strings + penalties. */
    enum class RejectReason { MAGIC, PARSE, STALE, DIFFICULTY, POW, SIGNATURE, REPLAY }

    sealed class Verdict {
        /**
         * [penalty] is null for failures that carry NO reputation hit (parse
         * failure, replay): penalties are anchored on the sender's observable
         * offenses, and these two either have no sender attribution or are
         * already fully handled by the authenticated-frame admission.
         */
        data class Rejected(val reason: RejectReason, val penalty: Int?) : Verdict()
        data class Accepted(
            val frame: MeshWire.Frame,
            val secureMsg: CryptoEngine.SecureMessage,
            // ECHO: the base64-decoded hop counter. E2EE for another peer:
            // null (never punish the relay). Decryptable: the plaintext.
            val decrypted: ByteArray?
        ) : Verdict()
    }

    /**
     * Verify one incoming frame through the original gate order:
     * magic → parse → freshness → difficulty → PoW → signature →
     * anti-replay admission (atomic, AFTER authentication — audit) →
     * seen-cache cap → decrypt/echo-decode.
     *
     * Signature validity alone does not imply freshness. Stale frames and
     * timestamps too far in the future are rejected BEFORE spending CPU on
     * PoW or cryptographic verification. The timestamp is signed, so this
     * gate cannot be bypassed by a relay changing metadata.
     */
    fun evaluate(
        bytes: ByteArray,
        now: Long,
        messageTtlMs: Long,
        clockSkewMs: Long,
        networkPowDifficulty: Int
    ): Verdict {
        // Wire format: only magic-framed frames (deflate or raw-flagged)
        // are accepted. Decoding a raw frame as JSON would defeat the
        // format gate and risk parsing attacker-chosen bytes as JSON.
        val json = MeshWire.decompress(bytes)
            ?: return Verdict.Rejected(RejectReason.MAGIC, MeshReputation.REPUTATION_MALFORMED_FRAME)
        val payload = MeshWire.parseFrame(json)
            ?: return Verdict.Rejected(RejectReason.PARSE, null)

        if (!MeshWire.isFreshTimestamp(payload.timestamp, now, messageTtlMs, clockSkewMs)) {
            return Verdict.Rejected(RejectReason.STALE, MeshReputation.REPUTATION_MALFORMED_FRAME)
        }

        // Proof-of-Work verification: the nonce is carried in the payload
        // and checked at every hop — solving without transmitting/verifying
        // would be a no-op. Difficulty is clamped to a sane band: solving
        // more than our constant is a marker of a modified (non-stock)
        // client and is rejected, keeping the network uniform. The receiver
        // does NOT trust the sender's declared difficulty — a frame carrying
        // anything other than the network requirement is rejected before any
        // hashing, which bounds the verification cost an untrusted neighbor
        // can impose (a "difficulty 999999" frame is dropped, not computed).
        if (payload.powDifficulty != networkPowDifficulty) {
            return Verdict.Rejected(RejectReason.DIFFICULTY, MeshReputation.REPUTATION_BAD_DIFFICULTY)
        }
        // Canonical challenge framing (audit round 11): same
        // length-prefixed composition the origin used to solve.
        val powPrefix = MeshWire.ProofOfWork.wirePrefix(payload.messageId, payload.origEphemeralId)
        if (!MeshWire.ProofOfWork.verify(powPrefix, payload.powNonce, payload.powDifficulty)) {
            return Verdict.Rejected(RejectReason.POW, MeshReputation.REPUTATION_BAD_POW)
        }

        // Verify the ECDSA signature over the CANONICAL SIGNED METADATA
        // (ciphertext + iv + messageId + type + hopCount + origEphemeralId
        // + origPublicKey + timestamp + nonce + lat + lng) — public-key
        // integrity check available to every relay, independent of the AES
        // key. A relay cannot alter lat/lng/type/nonce/messageId anymore
        // without invalidating the signature (audit).
        //
        // Audit round 11: the signature check is now UNCONDITIONAL. The
        // old `type != ECHO` exemption let anyone (a peer with a valid PoW
        // budget, i.e. any nearby device) push UNVERIFIED plaintext into
        // notifyListeners — ECHO's payload is decoded directly, so an
        // attacker could inject arbitrary text into the UI with zero
        // cryptographic proof. No legitimate caller emits ECHO today, so
        // exempting nothing costs nothing.
        val secureMsg = CryptoEngine.SecureMessage(
            ephemeralId = payload.origEphemeralId,
            senderPublicKey = payload.origPublicKey,
            ciphertext = payload.payloadB64,
            iv = payload.iv,
            signature = payload.signature,
            timestamp = payload.timestamp,
            lat = payload.lat,
            lng = payload.lng,
            nonce = payload.nonce,
            messageId = payload.messageId,
            type = payload.type,
            hopCount = payload.hopCount
        )

        if (!verifySignature(secureMsg)) {
            return Verdict.Rejected(RejectReason.SIGNATURE, MeshReputation.REPUTATION_BAD_SIGNATURE)
        }

        // Anti-replay / anti-broadcast-storm — ONLY AFTER authentication:
        // recording (messageId + nonce) BEFORE the PoW + signature checks
        // let a forged invalid frame poison the cache and block the valid
        // one (audit). Only authenticated frames may enter the seen-cache.
        val msgHash = MeshWire.seenMessageHash(payload.messageId, payload.nonce)
        // Atomic admission prevents two concurrent Nearby callbacks from
        // accepting the same authenticated frame at the same time.
        if (seenMessageHashes.putIfAbsent(msgHash, now) != null) {
            return Verdict.Rejected(RejectReason.REPLAY, null)
        }
        enforceSeenCap()

        val decrypted = if (payload.type == TYPE_ECHO) {
            // Echo messages are plaintext hop counters by design — but
            // they are SIGNED like every other frame (see above).
            java.util.Base64.getDecoder().decode(payload.payloadB64)
        } else {
            decrypt(secureMsg)
        }

        return Verdict.Accepted(payload, secureMsg, decrypted)
    }

    /**
     * Unbounded cache = untrusted growth window (audit): evict the OLDEST
     * entry as soon as the cap is exceeded. Enforced at insert time
     * (evaluate) and re-run by the tick as a safety net.
     */
    fun enforceSeenCap() {
        while (seenMessageHashes.size > MAX_SEEN_HASHES) {
            seenMessageHashes.entries.minByOrNull { it.value }
                ?.let { seenMessageHashes.remove(it.key) } ?: break
        }
    }

    /**
     * Replay-window sweep run by the tick: entries older than the message
     * TTL + clock skew can no longer represent a replayable frame (any
     * re-send of them fails the freshness gate first), so they leave the
     * cache (verbatim cutoff math).
     */
    fun sweepReplayWindow(replayCutoff: Long) {
        seenMessageHashes.entries.removeAll { it.value < replayCutoff }
    }
}
