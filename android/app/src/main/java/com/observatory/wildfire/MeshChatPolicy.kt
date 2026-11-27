package com.observatory.wildfire

/** Plain text fallback: old and new receivers display chat without JSON intel.
 * Prefixing also prevents JSON typed by a user from being parsed as fire intel. */
object MeshChatPolicy {
    fun plaintext(text: String): String = "💬 " + text.take(160)
}
