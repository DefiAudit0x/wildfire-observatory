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
     * this peer for this message" — both retry blockers must be clear. The
     * service's hot path gates re-sends on the forwarded marker only
     * (`!queue.isForwarded(...)`, MeshService.kt:1046); `attemptedTargets`
     * is eviction bookkeeping (the all-delivered rule in
     * MeshQueue.sweepExpiredMessages), not a retry gate — and this
     * predicate has no production caller. Keep the reference semantics
     * pinned: the JVM tests fail loudly if they drift.
     */
    fun canRetry(
        endpointId: String,
        messageId: String,
        forwardedMessages: Map<String, Long>,
        attemptedTargets: Set<String>
    ): Boolean = !forwardedMessages.containsKey("$endpointId:$messageId") &&
        !attemptedTargets.contains(endpointId)
}
