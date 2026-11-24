package com.observatory.wildfire

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fix 49 (NREP-8): pure send-failure policy tests. A 429 is a
 * time-limited refusal, not a permanent validation/auth failure — it
 * must fall through to the enqueue path, where the drain loop retries
 * it with backoff. Every other 4xx stays permanent; 5xx was never
 * permanent (it already enqueued).
 */
class SendPolicyTest {

    @Test
    fun `429 is retryable (finding)`() {
        assertFalse(SendPolicy.isPermanentRejection(429))
    }

    @Test
    fun `400 is permanent (control)`() {
        assertTrue(SendPolicy.isPermanentRejection(400))
    }

    @Test
    fun `401 is permanent (control)`() {
        assertTrue(SendPolicy.isPermanentRejection(401))
    }

    @Test
    fun `404 is permanent (control)`() {
        assertTrue(SendPolicy.isPermanentRejection(404))
    }

    @Test
    fun `409 is permanent (control)`() {
        assertTrue(SendPolicy.isPermanentRejection(409))
    }

    @Test
    fun `500 is retryable (control)`() {
        assertFalse(SendPolicy.isPermanentRejection(500))
    }

    @Test
    fun `503 is retryable (control)`() {
        assertFalse(SendPolicy.isPermanentRejection(503))
    }
}
