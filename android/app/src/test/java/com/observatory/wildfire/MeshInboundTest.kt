package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * ARC-H16 pinning specs for the inbound authentication pipeline extracted
 * from MeshService. The gate ORDER and the penalty ladder are the security
 * contract — pinned end to end here with INJECTED crypto lambdas:
 *
 *   magic → parse → freshness → difficulty → PoW → signature →
 *   anti-replay admission (atomic, AFTER authentication) → seen-cap →
 *   echo-decode / injected decrypt.
 *
 * Penalties: MAGIC/STALE → MALFORMED(-10), DIFFICULTY → -30, POW → -20,
 * SIGNATURE → -40, PARSE and REPLAY → null (never punished). A frame whose
 * decrypt returns null (E2EE addressed elsewhere) is ACCEPTED untouched —
 * never punish relays. Replay admits silently nothing: no penalty, no state.
 */
class MeshInboundTest {

    private val now = 1_700_000_000_000L
    private val ttl = MeshQueue.MESSAGE_TTL_MS
    private val skew = 2 * 60 * 1000L
    private val difficulty = MeshWire.NETWORK_POW_DIFFICULTY

    // ---- frame construction helpers ----

    private fun canonicalB64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private fun solvedNonce(messageId: String, ephemeralId: String, diff: Int = difficulty): Int =
        MeshWire.ProofOfWork.solve(
            MeshWire.ProofOfWork.wirePrefix(messageId, ephemeralId),
            diff
        ) ?: throw AssertionError("PoW solve unexpectedly exhausted")

    /** Deterministic nonce that FAILS verification for this (messageId, ephemeralId) pair. */
    private fun failingNonce(messageId: String, ephemeralId: String, diff: Int = difficulty): Int {
        val prefix = MeshWire.ProofOfWork.wirePrefix(messageId, ephemeralId)
        var n = 0
        while (MeshWire.ProofOfWork.verify(prefix, n, diff)) n++
        return n
    }

    private fun frame(
        messageId: String = "msg-1",
        type: String = MeshInbound.TYPE_REPORT,
        payloadB64: String = canonicalB64("plaintext-payload".toByteArray()),
        timestamp: Long = now,
        powNonce: Int = solvedNonce(messageId, "EPH_1"),
        powDifficulty: Int = difficulty,
        hopsLeft: Int = 3,
        nonce: Int = 7
    ): MeshWire.Frame =
        MeshWire.Frame(
            protocolVersion = MeshWire.PROTOCOL_VERSION,
            messageId = messageId,
            type = type,
            payloadB64 = payloadB64,
            iv = canonicalB64(ByteArray(12)),
            hopCount = 0,
            origEphemeralId = "EPH_1",
            origPublicKey = canonicalB64(ByteArray(32)),
            timestamp = timestamp,
            signature = canonicalB64(ByteArray(64)),
            nonce = nonce,
            lat = 36.7538,
            lng = 3.0588,
            powNonce = powNonce,
            powDifficulty = powDifficulty,
            hopsLeft = hopsLeft
        )

    private fun wireBytes(f: MeshWire.Frame): ByteArray =
        MeshWire.compress(MeshWire.frameToJson(f).toByteArray(Charsets.UTF_8))

    private fun inbound(
        verify: (CryptoEngine.SecureMessage) -> Boolean = { true },
        decrypt: (CryptoEngine.SecureMessage) -> ByteArray? = { "decrypted-body".toByteArray() }
    ): MeshInbound = MeshInbound(verify, decrypt)

    private fun evaluate(
        f: MeshWire.Frame,
        inbound: MeshInbound = inbound(),
        at: Long = now
    ): MeshInbound.Verdict = inbound.evaluate(wireBytes(f), at, ttl, skew, difficulty)

    // ---- accept paths ----

    @Test
    fun validFrameIsAcceptedWithDecryptedPlaintext() {
        val verdict = evaluate(frame())
        assertTrue(verdict is MeshInbound.Verdict.Accepted)
        verdict as MeshInbound.Verdict.Accepted
        assertEquals("msg-1", verdict.frame.messageId)
        assertEquals("decrypted-body", String(verdict.decrypted!!, Charsets.UTF_8))
        assertEquals("msg-1", verdict.secureMsg.messageId)
    }

    @Test
    fun validEchoFrameDecodesBase64PlaintextWithoutDecrypt() {
        val echoPayload = canonicalB64("ping".toByteArray())
        var decryptCalled = false
        val inb = inbound(decrypt = { decryptCalled = true; null })
        val verdict = evaluate(frame(type = MeshInbound.TYPE_ECHO, payloadB64 = echoPayload), inbound = inb)
        assertTrue(verdict is MeshInbound.Verdict.Accepted)
        verdict as MeshInbound.Verdict.Accepted
        assertEquals("ping", String(verdict.decrypted!!, Charsets.UTF_8))
        assertFalse(decryptCalled) // echo path must not touch E2EE decryption
    }

    @Test
    fun e2eeFrameAddressedElsewhereIsAcceptedWithNullPlaintext() {
        // Not decryptable ≠ malicious: the relay path depends on this.
        val verdict = evaluate(frame(), inbound = inbound(decrypt = { null }))
        assertTrue(verdict is MeshInbound.Verdict.Accepted)
        assertNull((verdict as MeshInbound.Verdict.Accepted).decrypted)
    }

    // ---- reject paths + penalty ladder ----

    @Test
    fun nonMagicBytesRejectedAsMalformedWithPenalty() {
        val verdict = inbound().evaluate("garbage-no-magic".toByteArray(), now, ttl, skew, difficulty)
        assertEquals(MeshInbound.RejectReason.MAGIC, (verdict as MeshInbound.Verdict.Rejected).reason)
        assertEquals(MeshReputation.REPUTATION_MALFORMED_FRAME, verdict.penalty)
    }

    @Test
    fun corruptBodyThatStillCarriesMagicIsSilentlyRejectedWithoutPenalty() {
        // parse failures were NEVER penalized in the original (drop, no state).
        // FLAG_RAW (0x01) makes decompress return the body as text; the text
        // then fails parseFrame (not 16 pipe-joined fields).
        val magicOnly = byteArrayOf(0x4D, 0x43, 0x01) + "not-a-frame".toByteArray()
        val verdict = inbound().evaluate(magicOnly, now, ttl, skew, difficulty)
        assertEquals(MeshInbound.RejectReason.PARSE, (verdict as MeshInbound.Verdict.Rejected).reason)
        assertNull(verdict.penalty)
    }

    @Test
    fun staleTimestampRejectedWithMalformedPenalty() {
        val verdict = evaluate(frame(timestamp = now - ttl - skew - 1))
        assertEquals(MeshInbound.RejectReason.STALE, (verdict as MeshInbound.Verdict.Rejected).reason)
        assertEquals(MeshReputation.REPUTATION_MALFORMED_FRAME, verdict.penalty)
    }

    @Test
    fun futureDatedTimestampBeyondSkewRejectedWithMalformedPenalty() {
        val verdict = evaluate(frame(timestamp = now + skew + 1))
        assertEquals(MeshInbound.RejectReason.STALE, (verdict as MeshInbound.Verdict.Rejected).reason)
        assertEquals(MeshReputation.REPUTATION_MALFORMED_FRAME, verdict.penalty)
    }

    @Test
    fun outOfBandDifficultyRejectedBeforeAnyHashing() {
        // A "difficulty 999999" frame is dropped, not computed.
        val verdict = evaluate(frame(powDifficulty = 999999, powNonce = 0))
        assertEquals(MeshInbound.RejectReason.DIFFICULTY, (verdict as MeshInbound.Verdict.Rejected).reason)
        assertEquals(MeshReputation.REPUTATION_BAD_DIFFICULTY, verdict.penalty)
    }

    @Test
    fun failedProofOfWorkRejectedWithBadPowPenalty() {
        val bad = failingNonce("msg-1", "EPH_1")
        val verdict = evaluate(frame(powNonce = bad))
        assertEquals(MeshInbound.RejectReason.POW, (verdict as MeshInbound.Verdict.Rejected).reason)
        assertEquals(MeshReputation.REPUTATION_BAD_POW, verdict.penalty)
    }

    @Test
    fun failedSignatureRejectedWithBadSignaturePenalty() {
        val verdict = evaluate(frame(), inbound = inbound(verify = { false }))
        assertEquals(MeshInbound.RejectReason.SIGNATURE, (verdict as MeshInbound.Verdict.Rejected).reason)
        assertEquals(MeshReputation.REPUTATION_BAD_SIGNATURE, verdict.penalty)
    }

    // ---- gate ORDER (a forged frame must die at the EARLIEST gate) ----

    @Test
    fun staleFrameDiesBeforeDifficultyAndPowChecks() {
        val verdict = evaluate(frame(timestamp = now - ttl - skew - 1, powDifficulty = 999999, powNonce = 0))
        assertEquals(MeshInbound.RejectReason.STALE, (verdict as MeshInbound.Verdict.Rejected).reason)
    }

    @Test
    fun wrongDifficultyDiesBeforePowVerification() {
        val verdict = evaluate(frame(powDifficulty = difficulty + 1, powNonce = 12345))
        assertEquals(MeshInbound.RejectReason.DIFFICULTY, (verdict as MeshInbound.Verdict.Rejected).reason)
    }

    @Test
    fun badPowDiesBeforeSignatureVerification() {
        var verifyCalled = false
        val inb = inbound(verify = { verifyCalled = true; true })
        val verdict = evaluate(frame(powNonce = failingNonce("msg-1", "EPH_1")), inbound = inb)
        assertEquals(MeshInbound.RejectReason.POW, (verdict as MeshInbound.Verdict.Rejected).reason)
        assertFalse(verifyCalled)
    }

    @Test
    fun badSignatureDiesBeforeReplayAdmission() {
        val inb = inbound(verify = { false })
        // First pass: rejected on signature — and the seen-cache must NOT have
        // recorded the hash (only AUTHENTICATED frames enter the cache).
        val first = evaluate(frame(), inbound = inb)
        assertEquals(MeshInbound.RejectReason.SIGNATURE, (first as MeshInbound.Verdict.Rejected).reason)
        assertTrue(inb.seenMessageHashes.isEmpty())
    }

    // ---- anti-replay / seen-cache ----

    @Test
    fun replayedFrameRejectedSilentlyWithoutPenalty() {
        val inb = inbound()
        val first = evaluate(frame(), inbound = inb)
        assertTrue(first is MeshInbound.Verdict.Accepted)
        val second = evaluate(frame(), inbound = inb)
        assertEquals(MeshInbound.RejectReason.REPLAY, (second as MeshInbound.Verdict.Rejected).reason)
        assertNull(second.penalty)
        assertEquals(1, inb.seenMessageHashes.size)
    }

    @Test
    fun sameMessageDifferentNonceHashesApart() {
        val inb = inbound()
        assertTrue(evaluate(frame(nonce = 7), inbound = inb) is MeshInbound.Verdict.Accepted)
        assertTrue(evaluate(frame(nonce = 8), inbound = inb) is MeshInbound.Verdict.Accepted)
        assertEquals(2, inb.seenMessageHashes.size)
    }

    @Test
    fun seenCapEvictsOldestEntry() {
        val inb = MeshInbound({ true }, { null })
        // Fill the cache DIRECTLY past the cap (fast + deterministic): keys
        // 0..4096 with increasing timestamps; the cap must evict the OLDEST
        // (key 0) while size stays pinned at MAX_SEEN_HASHES.
        repeat(MeshInbound.MAX_SEEN_HASHES + 1) { i ->
            inb.seenMessageHashes["hash-$i"] = i.toLong()
        }
        inb.enforceSeenCap()
        assertEquals(MeshInbound.MAX_SEEN_HASHES, inb.seenMessageHashes.size)
        assertFalse(inb.seenMessageHashes.containsKey("hash-0"))
        assertTrue(inb.seenMessageHashes.containsKey("hash-${MeshInbound.MAX_SEEN_HASHES - 1}"))
    }

    @Test
    fun replayWindowSweepDropsOnlyExpiredEntries() {
        val inb = MeshInbound({ true }, { null })
        inb.seenMessageHashes["old"] = now - (ttl + skew) - 1
        inb.seenMessageHashes["fresh"] = now - (ttl + skew) + 1
        inb.sweepReplayWindow(now - (ttl + skew))
        assertFalse(inb.seenMessageHashes.containsKey("old"))
        assertTrue(inb.seenMessageHashes.containsKey("fresh"))
    }

    // ---- SecureMessage assembly (what the signature actually covers) ----

    @Test
    fun secureMessageCarriesExactlyTheSignedFrameMetadata() {
        val f = frame()
        var seen: CryptoEngine.SecureMessage? = null
        val inb = inbound(verify = { seen = it; true })
        evaluate(f, inbound = inb)
        val sm = seen!!
        assertEquals(f.origEphemeralId, sm.ephemeralId)
        assertEquals(f.origPublicKey, sm.senderPublicKey)
        assertEquals(f.payloadB64, sm.ciphertext)
        assertEquals(f.iv, sm.iv)
        assertEquals(f.signature, sm.signature)
        assertEquals(f.timestamp, sm.timestamp)
        assertEquals(f.lat, sm.lat, 0.0)
        assertEquals(f.lng, sm.lng, 0.0)
        assertEquals(f.nonce, sm.nonce)
        assertEquals(f.messageId, sm.messageId)
        assertEquals(f.type, sm.type)
        assertEquals(f.hopCount, sm.hopCount)
    }
}
