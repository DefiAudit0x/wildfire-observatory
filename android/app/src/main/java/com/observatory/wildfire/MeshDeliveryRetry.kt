package com.observatory.wildfire

/**
 * Pure delivery-failure bookkeeping shared by the Nearby callback and JVM tests.
 * A transport acceptance marker is not a delivery acknowledgement: failure must
 * remove both retry blockers so the next trickle window can try the peer again.
 */
object MeshDeliveryRetry {
    fun onTransportFailure(
        endpointId: String,
        messageId: String,
        forwardedMessages: MutableMap<String, Long>,
        attemptedTargets: MutableSet<String>
    ) {
        forwardedMessages.remove("$endpointId:$messageId")
        attemptedTargets.remove(endpointId)
    }

    fun canRetry(
        endpointId: String,
        messageId: String,
        forwardedMessages: Map<String, Long>,
        attemptedTargets: Set<String>
    ): Boolean = !forwardedMessages.containsKey("$endpointId:$messageId") &&
        !attemptedTargets.contains(endpointId)
}
