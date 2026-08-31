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
