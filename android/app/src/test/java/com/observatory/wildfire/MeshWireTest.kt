package com.observatory.wildfire

import org.junit.Assert.*
import org.junit.Test
import java.util.Arrays

/**
 * JVM unit tests for the pure wire-format layer (audit round: the deep mesh
 * changes — magic framing, compression fallback, PoW, signed-metadata
 * canonicality, anti-replay hashing, field-count/version gates — previously
 * had NO coverage; MeshService lives behind Android services, MeshWire does
 * not).
 */
class MeshWireTest {

    private fun sampleFrame(): MeshWire.Frame = MeshWire.Frame(
        protocolVersion = MeshWire.PROTOCOL_VERSION,
        messageId = "msg-42",
        type = "report",
        payloadB64 = "c2lnaDUtxZXJ5dGV4dA==",
        iv = "aXZWaXZJdg==",
        hopCount = 0,
        origEphemeralId = "eph1",
        origPublicKey = "MIGBMBAGAoIBAQDA4qz0M43IvBKKbWw==",
        timestamp = 1_700_000_000_000L,
        signature = "c2lnbmF0dXJl",
        nonce = 7,
        lat = 36.75,
        lng = 7.45,
        powNonce = 1234,
        powDifficulty = 8,
        hopsLeft = 5
    )

    // ---------- framing ----------

    @Test
    fun frameRoundTripSurvivesCompression() {
        val frame = sampleFrame()
        val encoded = MeshWire.compress(MeshWire.frameToJson(frame).toByteArray())
        val decoded = MeshWire.decompress(encoded)
        assertEquals(MeshWire.frameToJson(frame), decoded)
        assertEquals(frame, MeshWire.parseFrame(decoded!!))
    }

    @Test
    fun frameWithoutMagicIsRejected() {
        val plain = MeshWire.frameToJson(sampleFrame()).toByteArray()
        assertNull(MeshWire.decompress(plain))
    }

    @Test
    fun corruptDeflateStreamIsRejectedNotReinterpreted() {
        // Magic + deflate flag + garbage: must fail, never read as raw.
        val corrupt = byteArrayOf(0x4D, 0x43, 0x00, 0x01, 0x02, 0x03, 0x04)
        assertNull(MeshWire.decompress(corrupt))
    }

    @Test
    fun rawCompressionFallbackIsExplicitlyFramedAndDecodable() {
        // Simulate the failure path: raw payload under FLAG_RAW (audit: the
        // old fallback emitted raw bytes under the DEFLATE magic and could
        // never be decoded — receivers always inflated).
        val rawBody = "raw-utf8-fallback".toByteArray()
        val rawFramed = byteArrayOf(0x4D, 0x43, 0x01) + rawBody
        assertEquals("raw-utf8-fallback", MeshWire.decompress(rawFramed))
    }

    @Test
    fun unknownCompressionFlagIsRejected() {
        val badFlag = byteArrayOf(0x4D, 0x43, 0x7F, 0x00)
        assertNull(MeshWire.decompress(badFlag))
    }

    // ---------- frame schema gates ----------

    @Test
    fun wrongFieldCountIsRejected() {
        val json = MeshWire.frameToJson(sampleFrame())
        assertNull(MeshWire.parseFrame(json + "|extra"))
        assertNull(MeshWire.parseFrame(json.split("|").drop(1).joinToString("|")))
    }

    @Test
    fun foreignProtocolVersionIsRejected() {
        val json = MeshWire.frameToJson(sampleFrame())
        val foreign = (MeshWire.PROTOCOL_VERSION + 1).toString() + "|" + json.split("|").drop(1).joinToString("|")
        assertNull(MeshWire.parseFrame(foreign))
    }

    @Test
    fun nonZeroHopCountIsRejected() {
        // hopCount is SIGNED and immutable — a nonzero value is an alien/legacy
        // frame by construction.
        val frame = sampleFrame().copy(hopCount = 1)
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(frame)))
    }

    @Test
    fun outOfBandHopsLeftIsRejected() {
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(hopsLeft = -1))))
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(hopsLeft = MeshWire.MAX_HOPS + 1))))
    }

    @Test
    fun nonFiniteOrOutOfBoundsCoordinatesAreRejected() {
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(lat = Double.NaN))))
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(lng = 200.0))))
    }

    @Test
    fun missingKeyMaterialIsRejected() {
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(origPublicKey = ""))))
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(signature = ""))))
    }

    // ---------- proof of work ----------

    @Test
    fun solvedNonceVerifies() {
        val solved = MeshWire.ProofOfWork.solve("prefix-1", 8)
        assertNotNull(solved)
        assertTrue(MeshWire.ProofOfWork.verify("prefix-1", solved!!, 8))
    }

    @Test
    fun wrongNonceDoesNotVerify() {
        assertFalse(MeshWire.ProofOfWork.verify("prefix-1", -1, 8))
    }

    @Test
    fun difficultyIsEightLeadingZeroBitsNotEightHexChars() {
        // target(8) = 1 << 24: value must be < 0x01000000 — i.e. the TOP 8
        // BITS of the 32-bit prefix are zero (≈1/256), NOT "8 hex characters"
        // (a much weaker requirement the old comment described). A value in
        // [0x01000000, 0x0FFFFFFF] — which WOULD satisfy "value < 16^8" —
        // must fail.
        val prefix = MeshWire.sha256Hex("x")
        val first8Hex = prefix.take(8)
        val value = first8Hex.fold(0L) { acc, c -> (acc shl 4) + c.digitToInt(16) }
        assertEquals(1L shl 24, MeshWire.ProofOfWork.target(8).toLong())
        assertEquals(value < MeshWire.ProofOfWork.target(8), MeshWire.ProofOfWork.verify("x", 0, 8))
    }

    @Test
    fun outOfBandDifficultyIsRejectedByCallersTargetBand() {
        // The verify() target clamps, but the NETWORK band check lives in the
        // service (PO_W_DIFFICULTY ceiling) — here we assert the target math
        // is sane at the band edges.
        assertTrue(MeshWire.ProofOfWork.target(1) > MeshWire.ProofOfWork.target(8))
        // 1 shl (32 - 31) = 2: at d=31 the value must stay under 2 (top 31
        // bits zero) — the strongest band the 32-bit prefix allows.
        assertEquals(2L, MeshWire.ProofOfWork.target(31).toLong())
    }

    // ---------- canonical signed metadata ----------

    @Test
    fun signedDataIsDeterministicForIdenticalInputs() {
        val a = MeshWire.buildSignedData(
            byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "m", "report", 0, "e", "k",
            1000L, 7, 36.75, 7.45
        )
        val b = MeshWire.buildSignedData(
            byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "m", "report", 0, "e", "k",
            1000L, 7, 36.75, 7.45
        )
        assertTrue(Arrays.equals(a, b))
    }

    @Test
    fun signedDataChangesWhenAnyRelayMutableMetadataChanges() {
        val base = { lat: Double ->
            MeshWire.buildSignedData(
                byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "m", "report", 0, "e", "k",
                1000L, 7, lat, 7.45
            )
        }
        // A relay altering lat/lng must change the signed bytes (audit: the
        // old signature covered only ciphertext+iv, so coordinate tampering
        // went unnoticed).
        assertFalse(Arrays.equals(base(36.75), base(36.80)))

        val byMessageId = { id: String ->
            MeshWire.buildSignedData(
                byteArrayOf(1, 2, 3), byteArrayOf(4, 5), id, "report", 0, "e", "k",
                1000L, 7, 36.75, 7.45
            )
        }
        assertFalse(Arrays.equals(byMessageId("m"), byMessageId("m2")))

        val byNonce = { n: Int ->
            MeshWire.buildSignedData(
                byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "m", "report", 0, "e", "k",
                1000L, n, 36.75, 7.45
            )
        }
        assertFalse(Arrays.equals(byNonce(7), byNonce(8)))

        val byHopCount = { h: Int ->
            MeshWire.buildSignedData(
                byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "m", "report", h, "e", "k",
                1000L, 7, 36.75, 7.45
            )
        }
        assertFalse(Arrays.equals(byHopCount(0), byHopCount(1)))

        val byCiphertext = { c: ByteArray ->
            MeshWire.buildSignedData(
                c, byteArrayOf(4, 5), "m", "report", 0, "e", "k", 1000L, 7, 36.75, 7.45
            )
        }
        assertFalse(Arrays.equals(byCiphertext(byteArrayOf(1, 2, 3)), byCiphertext(byteArrayOf(9, 9, 9))))
    }

    @Test
    fun signedDataIsUnambiguousAcrossFieldBoundaries() {
        // Equivalent concatenated content under DIFFERENT field splits must
        // not produce the same signed bytes (length-prefixed framing).
        val a = MeshWire.buildSignedData(
            byteArrayOf(1), byteArrayOf(2), "ab", "report", 0, "e", "k",
            1000L, 7, 36.75, 7.45
        )
        val b = MeshWire.buildSignedData(
            byteArrayOf(1), byteArrayOf(2), "a", "breport", 0, "e", "k",
            1000L, 7, 36.75, 7.45
        )
        assertFalse(Arrays.equals(a, b))
    }

    // ---------- anti-replay hash framing ----------

    @Test
    fun seenMessageHashIsCanonicalAcrossSameMessage() {
        assertEquals(
            MeshWire.seenMessageHash("m", 12),
            MeshWire.seenMessageHash("m", 12)
        )
    }

    @Test
    fun seenMessageHashIsAmbiguityFree() {
        // ("ab", 12) and ("ab1", 2) both concatenate to "ab12" — the naive
        // hash would collide; length-prefixing parts them (audit).
        assertNotEquals(
            MeshWire.seenMessageHash("ab", 12),
            MeshWire.seenMessageHash("ab1", 2)
        )
    }
}