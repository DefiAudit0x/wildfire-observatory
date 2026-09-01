# Release & Signing Doctrine

This document defines how a signed release of the Android app is produced.
Read it fully before cutting a release. The keystore is the app's identity:
**losing it means you can never update devices that installed an earlier
release** — Android rejects updates whose signature does not match.

## 1. Certificate

- File: `wildfire-release.jks` (PKCS12), alias `wildfire`, RSA-4096,
  validity 10000 days (~27 years), generated 2026-09-01.
- Lives **outside the repository** (owner holds ≥2 offline backups; see the
  backup guide delivered with the keystore). `.gitignore` blocks `*.jks`,
  `*.keystore` and `android/keystore.properties` as a hard backstop.
- Fingerprints (register these when restricting any future client-side API
  key, e.g. a native Maps SDK key — the key then only works inside our
  signed app):
  - SHA-1: `1D:47:C9:1D:BA:4C:AD:E1:0D:3E:7C:3E:FD:49:ED:1A:DB:DD:02:FB`
  - SHA-256: `E4:85:64:D2:7C:74:6A:51:11:EE:4A:DC:BB:B6:68:90:E5:6E:FC:63:EC:D0:82:15:73:4D:66:72:9B:F3:BB:92`

## 2. How signing is wired

- `android/app/build.gradle` reads `android/keystore.properties`
  (see `keystore.properties.example`). If the file is absent the release
  build type stays **unsigned** — a fresh checkout or a fork PR must never
  fail just because no certificate is mounted.
- CI (`.github/workflows/android.yml`, job `release`) reconstructs the
  same files from GitHub Actions secrets:
  | Secret | Content |
  |---|---|
  | `KEYSTORE_BASE64` | base64 of `wildfire-release.jks` |
  | `KEYSTORE_PASSWORD` | keystore + key password |
  | `KEY_ALIAS` | `wildfire` |
  | `KEY_PASSWORD` | key password |
  Then it runs `assembleRelease bundleRelease`, verifies the APK with
  `apksigner verify --print-certs`, computes `SHA256SUMS.txt` and uploads
  everything as a workflow artifact (30-day retention).
- R8 runs on release (`minifyEnabled true`). The WebView bridge,
  `MeshService` and the Bouncy Castle provider trees are pinned in
  `proguard-rules.pro`; the CI release job on every PR is what exercises
  the minified path before a merge can land.

## 3. Cutting a release

1. Land the release PR through the normal pipeline (green 5/5 CI).
2. Tag on `main`: `git tag vX.Y.Z && git push origin vX.Y.Z` (or create the
   release from the GitHub UI).
3. Take the `release-<sha>` artifact from the run of the merge commit on
   `main` (or the tag push) — it contains:
   - `app-release.apk` (direct distribution, GitHub Releases)
   - `app-release.aab` (Google Play upload)
   - `SHA256SUMS.txt`
4. Attach APK + checksums to the GitHub Release; publish notes.
5. For Play: upload the `.aab` (see `docs/PLAY_CHECKLIST.md` — Play App
   Signing will manage the app-signing key from the first upload; keep the
   local keystore as the upload key and DO NOT lose it regardless).

## 4. Versioning

- `versionCode`: monotonically increasing integer — bump **every** release
  (Play rejects equal-or-lower codes; direct installs silently ignore them).
- `versionName`: user-visible `MAJOR.MINOR.PATCH`.
- Never bump these on a branch; only on `main` via a release PR.

## 5. API keys

No sensitive API key ships inside the APK. Maps are keyless (Leaflet +
CARTO/OSM tiles); Gemini, NASA FIRMS, mail and Firebase admin credentials
live in **server environment only** (`server/config.ts`). If a future
feature genuinely requires a client-side key (e.g. native Maps SDK), it
must be restricted to package `com.observatory.wildfire` + the SHA-1
fingerprint above, with quotas and billing alerts set. Keys never enter
the repository: `.env` is gitignored, `.env.example` documents names only.

## 6. Failure modes

- **Keystore lost** → cannot update existing installs. Recovery: none.
  Prevention: the three-backup rule in the delivered backup guide.
- **Secrets rotated away / removed** → CI falls back to unsigned; release
  job stays green but the APK cannot be installed. `apksigner verify` and
  the `SIGNED` env flag make this visible in the run log.
- **R8 regression** → surfaces on the PR's release job, not in the field.
  Fix by adjusting `proguard-rules.pro` — never by disabling minification.
