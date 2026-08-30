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

    /**
     * ARC-L24: this predicate is the TEST-PINNED reference for "may we retry
     * this peer for this message". MeshService evaluates the SAME two
     * conditions inline on its hot path (guarding the actual re-send) rather
     * than calling in here; keep the two in sync — the JVM tests fail loudly
     * if the reference semantics drift.
     */
    fun canRetry(
        endpointId: String,
        messageId: String,
        forwardedMessages: Map<String, Long>,
        attemptedTargets: Set<String>
    ): Boolean = !forwardedMessages.containsKey("$endpointId:$messageId") &&
        !attemptedTargets.contains(endpointId)
}
