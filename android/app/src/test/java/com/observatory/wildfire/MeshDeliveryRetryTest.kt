package com.observatory.wildfire

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MeshDeliveryRetryTest {
    @Test
    fun transportFailureClearsMarkersAndAllowsNextRetry() {
        val forwardedMessages = mutableMapOf("peer-1:message-1" to 123L)
        val attemptedTargets = mutableSetOf("peer-1")

        assertFalse(
            MeshDeliveryRetry.canRetry(
                "peer-1",
                "message-1",
                forwardedMessages,
                attemptedTargets
            )
        )

        MeshDeliveryRetry.onTransportFailure(
            "peer-1",
            "message-1",
            forwardedMessages,
            attemptedTargets
        )

        assertTrue(
            MeshDeliveryRetry.canRetry(
                "peer-1",
                "message-1",
                forwardedMessages,
                attemptedTargets
            )
        )
    }
}
