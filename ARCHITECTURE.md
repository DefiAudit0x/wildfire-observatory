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
