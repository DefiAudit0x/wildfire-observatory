package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Fix 55 (NSVC-3): the trickle delay choice is a pure function on the
 * service companion so it is JVM-testable (the service itself is
 * Android-only). Awake ticks must honor the backed-off interval instead
 * of always running at TRICKLE_I_MIN.
 */
class MeshServiceTrickleTest {

    @Test
    fun awakeUsesBackedOffInterval() {
        assertEquals(1000L, MeshService.nextTrickleDelayMs(false, MeshService.TRICKLE_I_MIN))
        assertEquals(30_000L, MeshService.nextTrickleDelayMs(false, MeshService.TRICKLE_I_MAX))
    }

    @Test
    fun sleepingUsesSleepInterval() {
        assertEquals(MeshService.SLEEP_INTERVAL, MeshService.nextTrickleDelayMs(true, MeshService.TRICKLE_I_MIN))
        assertEquals(MeshService.SLEEP_INTERVAL, MeshService.nextTrickleDelayMs(true, MeshService.TRICKLE_I_MAX))
    }

    @Test
    fun invalidUtf8ReencodedPlaintextExceedsTheGate() {
        // Fix 56b: 190 KiB of 0xFF bytes passes the decoded byte gate
        // (194560 <= MAX) but decodes to 194560 U+FFFD, which re-encode
        // to 583680 bytes — the relay admission must reject it.
        val invalidUtf8 = ByteArray(MeshService.MAX_PLAINTEXT_BYTES) { 0xFF.toByte() }
        assertEquals(false, MeshService.reencodedPlaintextFits(invalidUtf8))
    }

    @Test
    fun validUtf8AtTheCeilingFitsTheReencodedGate() {
        val valid = ByteArray(MeshService.MAX_PLAINTEXT_BYTES) { 0x61 }
        assertEquals(true, MeshService.reencodedPlaintextFits(valid))
    }
}
