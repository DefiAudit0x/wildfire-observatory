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
        payloadB64 = "c2lnbmVkLXRleHQ=",
        iv = "aXZWaXZJdg==",
        hopCount = 0,
        origEphemeralId = "eph1",
        origPublicKey = "a2V5",
        timestamp = 1_700_000_000_000L,
        signature = "c2lnbmF0dXJl",
        nonce = 7,
        lat = 36.75,
        lng = 7.45,
        powNonce = 1234,
        powDifficulty = 8,
        hopsLeft = 5
    )

    @Test
    fun keyBoundSchemeUsesExistingWireFormatWithoutVersionBump() {
        val original = sampleFrame()
        val bound = original.copy(origEphemeralId = MeshIdentityBinding.issue(original.origPublicKey))
        assertTrue(bound.origEphemeralId.length <= 64)
        assertEquals(bound, MeshWire.parseFrame(MeshWire.frameToJson(bound)))
        assertEquals(original, MeshWire.parseFrame(MeshWire.frameToJson(original)))
    }

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
    fun deflateStreamWithTrailingBytesIsRejected() {
        val encoded = MeshWire.compress("strict-frame".toByteArray())
        assertNull(MeshWire.decompress(encoded + byteArrayOf(0x55)))
    }

    @Test
    fun invalidUtf8RawBodyIsRejected() {
        val invalidUtf8 = byteArrayOf(0x4D, 0x43, 0x01, 0xC3.toByte(), 0x28)
        assertNull(MeshWire.decompress(invalidUtf8))
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
    fun compressFallsBackToRawFramingWhenDeflateCannotFit() {
        // Incompressible input larger than the compressed cap: deflate
        // cannot shrink it below MAX_COMPRESSED_BODY_BYTES (128 KiB), so
        // compress must emit the RAW fallback — magic + FLAG_RAW +
        // verbatim bytes — never a truncated deflate stream or raw bytes
        // under the DEFLATE flag. (Verified: seeded random ASCII, 200_000
        // bytes, deflates to ~166 KiB — 35 KiB over the cap.)
        val random = java.util.Random(42)
        val data = ByteArray(200_000) { (random.nextInt(95) + 0x20).toByte() }
        val encoded = MeshWire.compress(data)
        assertEquals(0x4D.toByte(), encoded[0])
        assertEquals(0x43.toByte(), encoded[1])
        assertEquals(0x01.toByte(), encoded[2]) // FLAG_RAW (private const)
        assertEquals(3 + data.size, encoded.size)
        assertTrue(encoded.copyOfRange(3, encoded.size).contentEquals(data))
        // And the fallback frame still round-trips through the receiver.
        assertEquals(String(data, Charsets.UTF_8), MeshWire.decompress(encoded))
    }

    @Test
    fun unknownCompressionFlagIsRejected() {
        val badFlag = byteArrayOf(0x4D, 0x43, 0x7F, 0x00)
        assertNull(MeshWire.decompress(badFlag))
    }

    // ---------- decompression bomb defense (audit round 11) ----------

    @Test
    fun deflateBombCannotBlowPastDecompressedCap() {
        // A tiny deflate stream that inflates to ~300KB must be rejected: the
        // old code capped the COMPRESSED body only, letting a compressed bomb
        // allocate unbounded output. Build a real ~300KB air-payload and
        // compress it manually (MeshWire.compress is fine too, but the bomb
        // shape — small on the wire, huge after inflate — needs the manual
        // deflate).
        val air = ByteArray(300 * 1024) // zeros compress extremely well
        val deflater = java.util.zip.Deflater(java.util.zip.Deflater.BEST_COMPRESSION)
        deflater.setInput(air)
        deflater.finish()
        val outBuf = ByteArray(air.size + 1024)
        val n = deflater.deflate(outBuf)
        deflater.end()
        val bomb = byteArrayOf(0x4D, 0x43, 0x00) + outBuf.copyOf(n)
        // Compressed size is tiny — the old MAX_COMPRESSED_BODY_BYTES gate
        // would pass it; the decompressed cap must reject it.
        assertTrue(bomb.size < 2 * 1024)
        assertNull(MeshWire.decompress(bomb))
    }

    @Test
    fun oversizeRawBodyIsRejected() {
        // 300KB of raw (non-deflate) payload is over the decompressed cap.
        val body = ByteArray(300 * 1024) { 0x61 }
        val frame = byteArrayOf(0x4D, 0x43, 0x01) + body
        assertNull(MeshWire.decompress(frame))
    }

    // ---------- per-field length ceilings (audit round 11) ----------

    @Test
    fun oversizedFieldsAreRejected() {
        // 65-char messageId (limit 64)
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(messageId = "m".repeat(65)))))
        // 33-char type (limit 32)
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(type = "t".repeat(33)))))
        // 65-char ephemeral id (limit 64)
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(origEphemeralId = "e".repeat(65)))))
        // 513-char public key (limit 512)
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(origPublicKey = "k".repeat(513)))))
        // 513-char signature (limit 512)
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(signature = "s".repeat(513)))))
        // 65-char iv (limit 64)
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(iv = "i".repeat(65)))))
        // 128KB+ payload b64 — allowed ceiling is MAX_DECOMPRESSED_BODY_BYTES*4/3
        val bigPayload = "A".repeat(256 * 1024 * 4 / 3 + 17)
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(payloadB64 = bigPayload))))
        // A large canonical Base64 payload near the boundary must be accepted
        // (frame-level, not JSON-level).
        val atBoundary = "AAAA".repeat(87_392)
        assertNotNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(payloadB64 = atBoundary))))
    }

    // ---------- pipe-delimiter integrity (audit round 11) ----------

    @Test
    fun pipeCarryingFieldsAreRejectedOnParse() {
        // A '|' in any field shifts every following field: the frame must be
        // rejected, never silently re-interpreted. The hostile frame is built
        // by hand — a remote peer never goes through frameToJson, it sends
        // the raw wire string.
        fun hostile(index: Int, value: String): String {
            val parts = MeshWire.frameToJson(sampleFrame()).split("|").toMutableList()
            parts[index] = value
            return parts.joinToString("|")
        }
        // messageId=1, type=2, payloadB64=3, iv=4, origEphemeralId=6,
        // origPublicKey=7, signature=9
        assertNull(MeshWire.parseFrame(hostile(1, "a|b")))
        assertNull(MeshWire.parseFrame(hostile(2, "a|b")))
        assertNull(MeshWire.parseFrame(hostile(3, "a|b")))
        assertNull(MeshWire.parseFrame(hostile(4, "a|b")))
        assertNull(MeshWire.parseFrame(hostile(6, "a|b")))
        assertNull(MeshWire.parseFrame(hostile(7, "a|b")))
        assertNull(MeshWire.parseFrame(hostile(9, "a|b")))
    }

    @Test
    fun frameToJsonThrowsOnPipeInAnyField() {
        // Every pipe-carrying field must be rejected by the PRODUCER — a
        // producer check limited to messageId would satisfy the old
        // single-field test while the other six fields sailed through.
        // (frameToJson checks fields.any { it.contains('|') }; the numeric
        // fields can never carry a pipe, so only the seven string fields
        // are exercised — the same seven the parse side pins at indices
        // 1, 2, 3, 4, 6, 7, 9.)
        val withPipe = listOf(
            "messageId" to sampleFrame().copy(messageId = "a|b"),
            "type" to sampleFrame().copy(type = "a|b"),
            "payloadB64" to sampleFrame().copy(payloadB64 = "a|b"),
            "iv" to sampleFrame().copy(iv = "a|b"),
            "origEphemeralId" to sampleFrame().copy(origEphemeralId = "a|b"),
            "origPublicKey" to sampleFrame().copy(origPublicKey = "a|b"),
            "signature" to sampleFrame().copy(signature = "a|b")
        )
        for ((field, frame) in withPipe) {
            assertThrows(field, IllegalArgumentException::class.java) {
                MeshWire.frameToJson(frame)
            }
        }
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

    @Test
    fun malformedBase64FieldsAreRejectedAtParseBoundary() {
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(payloadB64 = "not-base64!"))))
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(iv = "not-base64!"))))
        assertNull(MeshWire.parseFrame(MeshWire.frameToJson(sampleFrame().copy(signature = "not-base64!"))))
    }

    @Test
    fun timestampFreshnessRejectsStaleAndTooFutureFrames() {
        val now = 1_000_000L
        val maxAge = 10 * 60 * 1000L
        val skew = 2 * 60 * 1000L
        assertTrue(MeshWire.isFreshTimestamp(now - maxAge, now, maxAge, skew))
        assertFalse(MeshWire.isFreshTimestamp(now - maxAge - 1, now, maxAge, skew))
        assertTrue(MeshWire.isFreshTimestamp(now + skew, now, maxAge, skew))
        assertFalse(MeshWire.isFreshTimestamp(now + skew + 1, now, maxAge, skew))
        assertFalse(MeshWire.isFreshTimestamp(Long.MIN_VALUE, now, maxAge, skew))
        assertFalse(MeshWire.isFreshTimestamp(Long.MAX_VALUE, now, maxAge, skew))
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
        // must fail. The challenge uses the canonical framed form
        // "len:prefix:nonce" (audit round 11).
        val first8Hex = MeshWire.sha256Hex("1:x:0").take(8)
        val value = first8Hex.fold(0L) { acc, c -> (acc shl 4) + c.digitToInt(16) }
        assertEquals(1L shl 24, MeshWire.ProofOfWork.target(8).toLong())
        assertEquals(value < MeshWire.ProofOfWork.target(8), MeshWire.ProofOfWork.verify("x", 0, 8))
    }

    @Test
    fun outOfBandDifficultyIsRejectedByCallersTargetBand() {
        // target() is strict now (audit round 11): out-of-band difficulty
        // throws, and solve/verify translate that into null/false instead of
        // silently clamping to a different band.
        assertTrue(MeshWire.ProofOfWork.target(1) > MeshWire.ProofOfWork.target(8))
        // 1 shl (32 - 31) = 2: at d=31 the value must stay under 2 (top 31
        // bits zero) — the strongest band the 32-bit prefix allows.
        assertEquals(2L, MeshWire.ProofOfWork.target(31).toLong())
        try {
            MeshWire.ProofOfWork.target(0)
            fail("target(0) must throw")
        } catch (e: IllegalArgumentException) {
            // expected
        }
        try {
            MeshWire.ProofOfWork.target(32)
            fail("target(32) must throw")
        } catch (e: IllegalArgumentException) {
            // expected
        }
        assertNull(MeshWire.ProofOfWork.solve("x", 0))
        assertFalse(MeshWire.ProofOfWork.verify("x", 0, 0))
        assertFalse(MeshWire.ProofOfWork.verify("x", 0, 32))
    }

    // ---------- canonical PoW challenge framing (audit round 11) ----------

    @Test
    fun wirePrefixIsCanonicalAcrossFieldBoundaries() {
        // "ab"+"12" and "ab1"+"2" concatenate identically ("ab12") — the
        // length-prefixed form keeps them apart, so a nonce solved for one
        // (messageId, origin) pair cannot be replayed against a colliding one.
        assertNotEquals(
            MeshWire.ProofOfWork.wirePrefix("ab", "12", 7),
            MeshWire.ProofOfWork.wirePrefix("ab1", "2", 7)
        )
        assertEquals(
            MeshWire.ProofOfWork.wirePrefix("ab", "12", 7),
            MeshWire.ProofOfWork.wirePrefix("ab", "12", 7)
        )
        // Fix 55 (NIN-1): the nonce is part of the challenge — the same
        // (messageId, origin) with a different nonce hashes apart.
        assertNotEquals(
            MeshWire.ProofOfWork.wirePrefix("ab", "12", 7),
            MeshWire.ProofOfWork.wirePrefix("ab", "12", 8)
        )
    }

    @Test
    fun solvedNonceDoesNotVerifyAgainstCollidingPrefix() {
        // Solve for ("ab", "12") and assert the nonce does NOT satisfy the
        // colliding ("ab1", "2") challenge. Framing makes these hash apart;
        // with the old naive concatenation both prefixes were "ab12" and the
        // nonce verified for both.
        val prefixA = MeshWire.ProofOfWork.wirePrefix("ab", "12", 7)
        val prefixB = MeshWire.ProofOfWork.wirePrefix("ab1", "2", 7)
        val nonce = MeshWire.ProofOfWork.solve(prefixA, 8)
        assertNotNull(nonce)
        assertTrue(MeshWire.ProofOfWork.verify(prefixA, nonce!!, 8))
        assertFalse(MeshWire.ProofOfWork.verify(prefixB, nonce, 8))
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

        val byLng = { lng: Double ->
            MeshWire.buildSignedData(
                byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "m", "report", 0, "e", "k",
                1000L, 7, 36.75, lng
            )
        }
        assertFalse(Arrays.equals(byLng(7.45), byLng(7.50)))

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

    // ---------- canonical coordinate serialization (audit round 12) ----------

    @Test
    fun canonicalLatLngIsMicroDegrees() {
        // The browser fallback signs with the SAME canonical form (see
        // meshBridge.canonicalLatLng): micro-degrees, Math.round(lat * 1e6).
        assertEquals("0", MeshWire.canonicalLatLng(0.0))
        assertEquals("36750000", MeshWire.canonicalLatLng(36.75))
        assertEquals("-1234568", MeshWire.canonicalLatLng(-1.2345678))
        // Float accumulation noise is absorbed by micro-degree rounding:
        // 0.1 + 0.2 == 0.30000000000000004 must NOT leak into the signed
        // bytes (the old Double.toString would emit different digits on
        // different runtimes anyway).
        assertEquals("300000", MeshWire.canonicalLatLng(0.1 + 0.2))
    }

    @Test
    fun canonicalSignedDataVectorsArePinnedForTheBrowserMirror() {
        // Byte-identical cross-runtime contract (audit round 12): the SAME
        // input must produce the SAME bytes in Kotlin (this test) and in the
        // browser fallback (tests/mesh-relay.test.ts pins this exact hex).
        // The old Double.toString serialization was runtime-unstable —
        // String(0)="0" in JS vs 0.0.toString()="0.0" in Kotlin — so a
        // browser-signed message could never verify against the native
        // verifier. Micro-degrees fix the bytes on both runtimes.
        val bytes = MeshWire.buildSignedData(
            ciphertext = byteArrayOf(),
            iv = byteArrayOf(),
            messageId = "m",
            type = "t",
            hopCount = 0,
            origEphemeralId = "e",
            origPublicKey = "k",
            timestamp = 123456789L,
            nonce = 42,
            lat = 0.1 + 0.2,
            lng = -1.2345678
        )
        val hex = bytes.joinToString("") { "%02X".format(it) }
        val expected = (
            "00000000" + // ciphertext (empty)
                "00000000" + // iv (empty)
                "000000016D" + // "m"
                "0000000174" + // "t"
                "0000000130" + // "0"
                "0000000165" + // "e"
                "000000016B" + // "k"
                "00000009313233343536373839" + // "123456789"
                "000000023432" + // "42"
                "00000006333030303030" + // "300000"  <- micro-degrees of 0.30000000000000004
                "000000082D31323334353638" // "-1234568" <- micro-degrees of -1.2345678
            )
        assertEquals(expected, hex)
    }

    // ---------- anti-replay hash framing ----------

    @Test
    fun seenMessageHashIsCanonicalAcrossSameMessage() {
        assertEquals(
            MeshWire.seenMessageHash("m", 12, "payload"),
            MeshWire.seenMessageHash("m", 12, "payload")
        )
    }

    @Test
    fun seenMessageHashIsAmbiguityFree() {
        // ("ab", 12) and ("ab1", 2) both concatenate to "ab12" — the naive
        // hash would collide; length-prefixing parts them (audit).
        assertNotEquals(
            MeshWire.seenMessageHash("ab", 12, "payload"),
            MeshWire.seenMessageHash("ab1", 2, "payload")
        )
        // Fix 55c: per-peer copies share (messageId, nonce) with distinct
        // payloads — the payload is part of the key, so they hash apart.
        assertNotEquals(
            MeshWire.seenMessageHash("ab", 12, "payload-A"),
            MeshWire.seenMessageHash("ab", 12, "payload-B")
        )
    }

    // ---------- Fix 55d: per-triple hash ----------

    @Test
    fun seenTripleHashIsCanonicalAcrossSameTriple() {
        assertEquals(
            MeshWire.seenTripleHash("m", 12),
            MeshWire.seenTripleHash("m", 12)
        )
    }

    @Test
    fun seenTripleHashIsAmbiguityFree() {
        assertNotEquals(
            MeshWire.seenTripleHash("ab", 12),
            MeshWire.seenTripleHash("ab1", 2)
        )
    }

    // ---------- Fix 56: wire size accounting (NWIRE-1) ----------

    /** Worst-case frame at the plaintext ceiling: simulated ciphertext
     * (plaintext + the 16-byte GCM tag) base64-encoded with padding — the
     * same shape the send path produces — with every metadata field at its
     * parse-side ceiling, so the bound holds under the strongest
     * assumption, not under today's generator sizes. */
    private fun maxPlaintextFrame(plaintextBytes: Int = MeshService.MAX_PLAINTEXT_BYTES): MeshWire.Frame =
        sampleFrame().copy(
            messageId = "m".repeat(64),
            type = "t".repeat(32),
            payloadB64 = java.util.Base64.getEncoder().encodeToString(ByteArray(plaintextBytes + 16)),
            iv = "i".repeat(64),
            origEphemeralId = "e".repeat(64),
            origPublicKey = "k".repeat(512),
            signature = "s".repeat(512)
        )

    @Test
    fun maxAcceptedPlaintextAlwaysFitsTheWire() {
        // Fix 56 (NWIRE-1): a frame carrying the largest accepted plaintext
        // must fit the 256 KiB wire ceiling. Fails on old code by
        // construction: MAX_PLAINTEXT_BYTES was 262144, so the payload
        // alone was 349548 base64 chars and the frame ~350896 bytes.
        MeshWire.compress(MeshWire.frameToJson(maxPlaintextFrame()).toByteArray())
    }

    @Test
    fun oversizeFrameIsRejectedByCompress() {
        // Guard test, not a finding test: passes on old code too — it pins
        // the require's existence. One extra payload byte would not move
        // the base64 length (quantization: 194576 bytes is 2 mod 3), so
        // the frame carries 2048 extra bytes, which provably crosses the
        // ceiling (payload 262168 chars before metadata).
        val frame = maxPlaintextFrame(MeshService.MAX_PLAINTEXT_BYTES + 2048)
        assertThrows(IllegalArgumentException::class.java) {
            MeshWire.compress(MeshWire.frameToJson(frame).toByteArray())
        }
    }
    @Test
    fun replayIdentityIncludesAuthenticatedSenderKey() {
        assertNotEquals(
            MeshWire.seenMessageHash("same", 7, "ciphertext", "key-A"),
            MeshWire.seenMessageHash("same", 7, "ciphertext", "key-B")
        )
        assertNotEquals(
            MeshWire.seenTripleHash("same", 7, "key-A"),
            MeshWire.seenTripleHash("same", 7, "key-B")
        )
    }

}
