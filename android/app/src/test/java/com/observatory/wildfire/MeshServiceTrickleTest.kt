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
}
