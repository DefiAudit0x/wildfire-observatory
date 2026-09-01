# Algerian Wildfire and Disaster Observatory — Architecture

> المعمارية الحالية والمستقبلية لمنصة المرصد الجزائري لحرائق الغابات والكوارث

---

## Status / المرحلة الحالية

**Phase:** `v1.0 — Monolithic` (Express + React SPA + Firebase)

---

## 1. Current Architecture / المعمارية الحالية

The deployed container runtime is defined by the committed `Dockerfile`.

```text
Browser
  ↓ HTTP (JSON)
Railway / container runtime (Node 22)
  ├─ Express API
  ├─ React/Vite build output
  ├─ Firestore
  └─ External APIs (NASA FIRMS, Gemini)
```

---

## 2. Technology Stack / رصة التقنيات

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 19 + TypeScript | UI |
| Build | Vite 6 | Bundler |
| Backend | Express + TypeScript | API server |
| Runtime | Node 22 | Server/container runtime |
| Package manager | pnpm 11.21.0 | Dependency management |
| Database | Firebase Firestore | Persistence |
| Analytics | NASA FIRMS API | Satellite hotspot data |
| AI | Google Gemini | Report analysis and guidance |
| Auth | JWT | Administration authentication |
| Validation | Zod | Input validation |
| Security | Helmet + CORS + rate limiting | HTTP security |
| Logging | Pino | Structured logging |
| Monitoring | Sentry | Error tracking |
| Testing | Vitest + Supertest + Testing Library + Playwright | Regression testing |
| Deploy | Railway / Docker | Hosting and runtime |

### Runtime source of truth

- `Dockerfile` uses `node:22-alpine` for build and runtime stages.
- `package.json` declares `node >=22.13.0` and `pnpm@11.21.0`.
- The committed Docker configuration is the source of truth for container deployments.

---

## 3. Data Flow / تدفق البيانات

### Report submission

`User → POST /api/reports → validation → geographic checks → persistence → response`

### Report confirmation

`User → POST /api/reports/:id/confirm → duplicate checks → Firestore transaction → consensus update`

### Satellite data

`GET /api/satellite-data → NASA FIRMS → normalization → response`

### AI guidance

`POST /api/ai/guidance → rate limiting → Gemini API → guidance response`

---

## 4. Repository Structure / هيكل المشروع

```text
observatory/
├── server/                 Express API
├── src/                    React SPA
├── tests/                  Server, React and E2E tests
├── android/                Native Android client
├── public/                 Static/PWA assets
├── .github/                CI workflows
├── Dockerfile              Container runtime definition
├── package.json            Node/pnpm requirements and scripts
├── pnpm-lock.yaml          Locked dependency graph
└── ARCHITECTURE.md         This document
```

---

## 5. Security Architecture / المعمارية الأمنية

The application uses HTTPS deployment, Helmet, CORS controls, rate limiting, Zod validation, JWT-based administration, server-side coordinate validation, Firestore transactions where required, and cryptographically generated identifiers.

Known protocol and scaling limitations are tracked explicitly in the audit process. Changes affecting persistence, identity, cryptographic binding, distributed uniqueness, or mesh transport semantics require explicit architectural decisions and regression tests.

### 5.1 Identity model (M15) / نموذج الهوية

There is exactly one client device label and several server-issued authorities, and the two layers must never be confused:

- **Device label** — `src/utils/device.ts` is the single generator. `web_<uuid>` in `localStorage["device_id"]`, mirrored per tab in sessionStorage. One-time migration adopts the legacy `mesh_device_id` (display-only for the mesh hub) and the native Android bridge UUID (first boot). Rotation happens only when storage is cleared. The label is a lookup/display key; it proves nothing.
- **Server authorities** — every security decision derives from a server-issued, scope-separated credential: staff/admin sessions (`role`-bearing JWTs, revalidated against Firestore), the public principal (anonymous actions: consensus voting, mesh relay, team join binding), team-member tokens (Team GPS channel only), and mesh tokens (`/ws` relay only). Scope tokens are rejected by `requireAuth` — a capability token is never a session credential.
- **Mesh crypto identity** — unchanged: peer public keys with TOFU records inside the Android keychain; orthogonal to the device label.

### 5.2 Team Mode live positions (Phase 1) / مواقع الفرق الحية

Field-team GPS is streamed through `POST /api/teams/heartbeat` (team-member Bearer token) into a per-process registry (`server/teamRegistry.ts`): 90s online window, 30-minute eviction, 50-point breadcrumb trail, NA-bounds gate, 3s per-member minimum interval. Durable state is a throttled snapshot (≤1 write per member per 5 min) into `teamMembers/{id}` so restarts recover last-known positions without paying Firestore per ping (~5.7k writes/member/day would be wasted otherwise). Positions are exposed ONLY to admin sessions (`GET /api/teams`); nothing team-related is broadcast on the public `/api/live` hub. `teamMissions/{teamId}` doubles as the one-team-one-mission lock (SOS dispatch transaction, 409 `TEAM_ALREADY_DISPATCHED`) and the mission the field app reads back on each heartbeat. Multi-instance deployments must move the registry to a shared store before scaling out.

### 5.3 Team membership revocation & dispatcher levers (Round B) / إبطال العضوية وأدوات المشرف

Team-member JWTs carry a per-member `gen` claim mirroring `teamMembers/{id}.tokenGen`. Dispatcher removal increments `tokenGen` FIRST, so every previously issued token (12h shift TTL notwithstanding) dies at the next gate hit — even if a later code rejoin reactivates the member row (rejoins preserve the bumped generation and mint fresh-generation tokens). Devices lost or reassigned can additionally be BLOCKED by principal: the join transaction rejects blocked principals fail-closed (`principal-blocked`), so a live join code alone can never bring a blocked device back. Removal also purges last-known GPS fields from the member doc (the doc shell stays for audit and deterministic rejoin identity). Resolve is one transaction (`resolveSosAtomically`): the SOS status flip and the team-mission clear read/write together, closing the resolve-vs-dispatch race that could orphan an active mission on a resolved SOS; the cleared count is surfaced and a zero-clear resolve is logged loudly. Dispatcher levers (PATCH team rename/active, DELETE mission force-clear, block-principal) turn previously dead guards into reachable operator controls. Rate limiting keys authenticated identities per-member/per-staff (IP remains the anonymous bucket); the heartbeat request log is demoted to debug with security rejections logged explicitly at warn; `fly.toml` keeps one machine warm (`min_machines_running = 1`) so the in-memory registry survives idle stops and deploys.

### 5.4 Field-team panel & native tracking (roadmap Phase 2) / لوحة الفريق والتتبع الأصلي

The member-facing half of Team Mode ships in two surfaces that share one session model:

- **Web panel** (`src/components/TeamPanel.tsx` + `src/utils/teamSession.ts`, tab `team`): join by dispatcher code (`POST /api/teams/join`), a browser heartbeat loop paced by the server's `heartbeatIntervalMs` (clamped 10–60s client-side), mission display, the single field-flippable phase `on_scene`, and leave. `POST /api/teams/session` (Phase 2) restores a persisted session on reload WITHOUT a GPS fix — the heartbeat hard-requires coordinates, but permission prompts happen after resume. The 12h token lives in **sessionStorage only** (dies with the tab; never localStorage, never a cookie). Verdict doctrine: ONLY 401/403 are session deaths; 400/429/5xx and transport errors are transient — a needless local logout forces a code re-join and burns the join-code budget (Round B), so transient failures keep the session and flag the connection instead.
- **Android native tracking** (`TeamLocationService.kt`, FGS type `location`): Android suspends WebView JS timers when the app is backgrounded or the screen turns off — unacceptable for wildfire shifts, and WebView geolocation is additionally deny-by-default (no `onGeolocationPermissionsShowPrompt` grant). The panel therefore hands its config to the service ONCE via the origin-gated bridge (`startTeamTracking`); the service re-validates EVERYTHING natively (`TeamLocationLogic`: exact-host allow-list = the union of the production Fly/Railway hosts over HTTPS plus loopback dev hosts, token sanity incl. header-injection rejection, `tm-<16hex>`/teamId shapes, 10–60s interval clamp) and then posts beats directly to the server. The token stays in memory only; the service uses `START_REDELIVER_INTENT` so a process kill resumes tracking and the first 401 self-stops it. Battery posture: FGS+location type without a wake lock; server-paced beats. targetSdk stays 34 (FGS `location` type is fully supported); the 35 bump is a separate decision bundled with the Phase 5 signed-APK work, not smuggled into this feature.

  Phase-2 critique hardening (post-review round): (1) **always-foreground-first** — `startForeground()` runs before ANY early exit in `onStartCommand` (ACTION_STOP / invalid config / missing FINE permission), because `startForegroundService` + a premature `stopSelf()` is a guaranteed `ForegroundServiceDidNotStartInTimeException` process crash on Android 12+; the bridge additionally refuses `startTeamTracking` without the FINE grant (defense in depth). (2) **Redirect pin** — `instanceFollowRedirects=false` on the beat connection: a 30x can never carry the Bearer token off the allow-listed host, and a raw redirect status classifies as RETRY per doctrine. (3) **Native mission channel** — every OK beat emits `teamTrackingState {state:"beat", missionJson}` carrying the server's mission object as a QUOTED JSON string (`extractMissionJson` → `JSONObject.quote` → panel `JSON.parse` + `normalizeNativeMission` allow-list); a fresh dispatch reaches the member's screen within one beat while the FGS owns the stream, and a null payload clears a stale card. (4) **Ask, don't guess** — the bridge exposes `isTeamTrackingActive()` (service-lifetime `AtomicBoolean`); a re-mounted panel queries it on mount, keeping the documented mutual exclusion (no JS+FGS double-stream / 429 flicker) across the ordinary tab-switch-and-return path. (5) **Honest `error` handling** — the panel resets `nativeActive` on `error` (the service's pre-`stopSelf` signal for every fatal except MEMBER_REVOKED) and immediately probes `/session` for the real verdict; a stale "will retry" lie over a dead stream can no longer strand the member off the command map. (6) **Leave stops the FGS** — a successful `leave` calls `stopTeamTracking()` (the stop control vanishes with the session card; without a GPS fix the orphan window would otherwise be indefinite). (7) **Mission sequencing** — a monotonic source counter guards every mission commit (probe/join/beat/flip/native-beat) so a pre-flip heartbeat response cannot flash `en_route` over `on_scene` (the W1 family, applied inside the panel). (8) The state listener is registered ONCE per activity in `onCreate` (renderer recovery re-runs `setupWebView` and would stack duplicate forwarders).

The FGS allow-list deliberately uses the UNION of the two existing native trust sets (WebAppInterface's production host + MainActivity's `APP_URL` host — the Railway and Fly deploy targets historically diverged); unifying those two lists into one shared constant is left as tracked tech debt so this PR stays additive.

---

## 6. Evolution Plan / خطة التطور

### Phase 2 — Modular / Monorepo evolution

Separate server, client and shared code when independent build and deployment boundaries become beneficial.

### Phase 3 — Further service separation

Consider independent services only when operational evidence justifies the added complexity, such as sustained traffic, team growth, or independently scalable workloads.

---

## 7. Key Decisions / قرارات معمارية

| Decision | Rationale |
|---|---|
| Monolith first | Faster iteration and lower operational complexity |
| Firebase | Managed persistence and real-time capabilities |
| Node + Express | Shared language ecosystem and mature tooling |
| Zod | TypeScript-oriented validation |
| Docker runtime definition | Reproducible deployment environment |
| pnpm lockfile | Reproducible dependency resolution |

---

## 8. Known Limitations & Audit Follow-up

The repository's security and protocol audit remains the authoritative place for active findings and deferred architectural decisions. Documentation must reflect the committed runtime and dependency requirements without silently treating unresolved protocol work as complete.
