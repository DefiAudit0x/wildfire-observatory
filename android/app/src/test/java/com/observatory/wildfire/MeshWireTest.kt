package com.observatory.wildfire

import org.junit.Assert.*
import org.junit.Test

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

    // ---------- framing ----------

    @Test
    fun frameRoundTripSurvivesCompression() {
        val frame = sampleFrame()
        val encoded = MeshWire.compress(MeshWire.frameToJson(frame).toByteArray())
        val decoded = MeshWire.decompress(encoded)
        assertEquals(MeshWire.frameToJson(frame), decoded)
        assertEquals(frame, MeshWire.parseFrame(decoded!!))
    }
