package com.observatory.wildfire

/**
 * Fix 49 (NREP-8): pure send-failure policy for [AppRepository].
 *
 * The repository's immediate send paths ([AppRepository.submitReport] and
 * [AppRepository.sendSos]) decide here, not inline in the suspending send
 * paths, so the decision is JVM-testable without an Android `Context`
 * (there is no `AppRepositoryTest` harness) — the RefreshPolicy house
 * pattern from Fix 17.
 *
 * A 429 is a time-limited refusal, not a validation/auth failure: all
 * three server limiters (SOS 2/min, reports 5/min, the shared API
 * limiter) run BEFORE the route handler, so nothing was stored
 * server-side and retrying the identical body is safe — and for SOS the
 * idempotency key makes a replay return the stored SOS, never a
 * duplicate. A 429 therefore falls through to the existing enqueue path
 * (the same path 5xx/offline already take), where the drain loop retries
 * it with per-entry exponential backoff.
 *
 * NOT folded in: `Retry-After` plumbing (`ObservatoryApi.Result.HttpError`
 * carries no headers, so a 429's server-advised wait is invisible) and
 * 408 Request Timeout, which stays permanent for now — both are
 * follow-ups (see FIX_PLAN.md Fix 49 §5).
 */
object SendPolicy {

    /**
     * True when the status is a permanent rejection — retrying the
     * identical body can never succeed. 429 is deliberately excluded:
     * it is transient, so it is NOT permanent.
     */
    fun isPermanentRejection(status: Int): Boolean =
        status in 400..499 && status != 429
}
