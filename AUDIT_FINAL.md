# Final Audit Round — 2026-08-22

## Scope

This round re-checks the findings that remained after the earlier audit rounds and PRs #17–#19, plus the Android verification gap.

## Confirmed closed findings

- Badge `maxUses` race: atomic validation/use consumption was moved into the Admin Firestore transaction in PR #17.
- Confirmation persistence failure semantics: Firestore failure now fails closed without RAM mutation/broadcast in PR #17.
- Mesh relay stale-flush race: guarded in PR #17.
- Durable replica divergence: IndexedDB/localStorage state is merged with terminal journal-state precedence in PR #18.
- Client Firestore report-cache invalidation: successful Client SDK confirmation now invalidates the reports cache in PR #19.

## Android verification

The Android module uses AGP 8.2.2, Kotlin 1.9.22, compileSdk/targetSdk 34, minSdk 26, Java/Kotlin target 17, and Bouncy Castle 1.85.2. The repository contains Gradle wrapper support files, including the wrapper JAR and a Gradle 8.5 distribution declaration, but does not contain the `gradlew` launcher script; the CI workflow therefore provisions Gradle 8.5 explicitly.

A dedicated GitHub Actions workflow was added on `main` in commit `176a504935338548c87cecdfa95dfcabfd3c05d1`. It provisions Java 17, Android SDK 34/build-tools 34.0.0, Gradle 8.5, then runs `gradle -p android test assembleDebug --stacktrace`.

The first Android verification run reached compilation and test execution but failed one JVM test, `MeshWireTest.frameRoundTripSurvivesCompression`, because its fixture used a non-canonical Base64 payload. The production parser correctly rejects that value. The fixture was corrected to canonical Base64, and the subsequent Android run passed.

The Android source review also re-checked the WebView trust boundary, JavaScript bridge origin gate, TLS policy, Android Keystore identity path, ephemeral-key snapshot/rotation model, wire-frame limits, compression-bomb protection, and signed metadata coverage.

## Final system-wide review

Reviewed boundaries include:

- HTTP security middleware, CORS, CSP, rate limits, and cookie CSRF protection.
- JWT/session handling and role checks.
- Firestore transaction/error semantics and cache invalidation.
- Browser mesh persistence/reconciliation and terminal-state handling.
- Android WebView navigation and JavaScript bridge exposure.
- Android cryptographic key storage, rotation, signing scope, and peer-key validation.
- Mesh wire framing, field limits, canonical encoding, decompression limits, and protocol/type validation.
- CI/build configuration and Node/pnpm runtime compatibility.

No new confirmed security or consistency finding was established in the final source review. The only Android verification failure found in this round was a malformed test fixture, not a production-code defect; it was corrected and the full Android workflow passed afterward.

## Validation gate

The audit is considered technically complete only after the Android workflow produces a successful `test` + `assembleDebug` result and the existing server/React/build/E2E/CodeQL checks remain green on the same post-PR-19 main lineage.
