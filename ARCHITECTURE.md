# Algerian Wildfire and Disaster Observatory — Architecture

> المعمارية الحالية والمستقبلية لمنصة المرصد الجزائري لحرائق الغابات والكوارث

---

## Status / المرحلة الحالية

**Phase:** `v1.0 — Monolithic` (Express + React SPA + Firebase)

---

## 1. Current Architecture / المعمارية الحالية

The deployed container runtime is defined by the committed `Dockerfile`.

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│         React SPA (Vite + TypeScript + Tailwind)            │
│         Leaflet Maps · Lucide Icons · Motion                │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP (JSON)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Railway (Node 22)                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Express Server (server.ts)                           │  │
│  │  · Helmet (CSP, CORS)                                 │  │
│  │  · Rate Limiting (general + AI)                       │  │
│  │  · Sentry error tracking                              │  │
│  │  · Swagger /api-docs                                  │  │
│  └──┬────────────────────────────────────────────────┬───┘  │
│     │                                                │       │
│     ▼                                                ▼       │
│  ┌─────────────┐                              ┌─────────────┐│
│  │ API Routes  │                              │ Vite / dist ││
│  └──────┬──────┘                              └─────────────┘│
│         │                                                   │
│         ▼                                                   │
│     Firestore + external APIs                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Technology Stack / رصة التقنيات

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 19 + TypeScript | UI |
| **Build** | Vite 6 | Bundler |
| **Styling** | Tailwind CSS 4 | Styling |
| **Backend** | Express + TypeScript | API server |
| **Runtime** | Node 22 (ESM-compatible tooling; production bundle is CJS) | Server runtime |
| **Package manager** | pnpm 11.21.0 | Dependency management |
| **Database** | Firebase Firestore (Admin + Client SDK) | Persistence |
| **Analytics** | NASA FIRMS API | Satellite hotspot data |
| **AI** | Google Gemini | Report analysis & guidance |
| **Auth** | JWT | Admin authentication |
| **Validation** | Zod | Input validation |
| **Security** | Helmet + CORS + Rate Limiting | HTTP security |
| **Logging** | Pino | Structured logging |
| **Monitoring** | Sentry | Error tracking |
| **Docs** | Swagger | API documentation |
| **Testing** | Vitest + Supertest + Testing Library + Playwright | Testing |
| **Deploy** | Railway / Docker | Hosting and container runtime |

### Runtime source of truth

- `Dockerfile` uses `node:22-alpine` for both build and runtime stages.
- `package.json` declares `node >=22.13.0` and `pnpm@11.21.0`.
- The committed Docker configuration is the runtime source of truth for container deployments.

---

## 3. Data Flow / تدفق البيانات

### Report Submission

`User → POST /api/reports → Zod validation → geographic checks → persistence → JSON response`

### Report Confirmation

`User → POST /api/reports/:id/confirm → duplicate checks → Firestore transaction → consensus update`

### Satellite Data

`GET /api/satellite-data → NASA FIRMS → parse/normalize → response`

### AI Guidance

`POST /api/ai/guidance → rate limit → Gemini API → guidance response`

---

## 4. Directory Structure / هيكل المشروع

```text
observatory/
├── server/                  Express API
├── src/                     React SPA
├── tests/                   Server, React and E2E tests
├── android/                 Native Android client
├── public/                  Static/PWA assets
├── .github/                 CI workflows
├── Dockerfile               Committed container runtime definition
├── package.json             Node/pnpm requirements and scripts
├── pnpm-lock.yaml           Locked dependency graph
└── ARCHITECTURE.md          This document
```

---

## 5. Security Architecture / المعمارية الأمنية

The application uses HTTPS deployment, Helmet, CORS controls, rate limiting, Zod validation, JWT-based administration, server-side coordinate validation, Firestore transactions where required, and cryptographically generated identifiers.

The security and protocol audit also tracks known limitations explicitly rather than treating them as resolved merely because they are documented.

---

## 6. Evolution Plan / خطة التطور

### Phase 2 — Modular / Monorepo evolution

Separate server, client and shared code when independent build and deployment boundaries become beneficial.

### Phase 3 — Further service separation

Consider independent services only when operational evidence justifies the added complexity, such as sustained traffic, team growth, or independently scalable workloads.

---

## 7. Key Decisions / قرارات معمارية

| Decision | Rationale |
|----------|-----------|
| **Monolith first** | Faster iteration and lower operational complexity |
| **Firebase** | Managed persistence and real-time capabilities |
| **Node + Express** | Shared language ecosystem and mature tooling |
| **Zod** | TypeScript-oriented validation |
| **Docker runtime definition** | Reproducible deployment environment |
| **pnpm lockfile** | Reproducible dependency resolution |

---

## 8. Known Limitations & Audit Follow-up

Known protocol and scaling limitations remain tracked in the repository audit process. Changes that alter persistence, identity, cryptographic binding, distributed uniqueness, or mesh transport semantics require explicit architectural decisions and regression tests rather than undocumented compatibility changes.
