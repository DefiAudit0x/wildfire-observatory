# North African Wildfire Observatory — Architecture

> المعمارية الحالية والمستقبلية لمنصة المرصد الشمال إفريقي لحرائق الغابات

---

## Status / المرحلة الحالية

**Phase:** `v1.0 — Monolithic` (Express + React SPA + Firebase)

---

## 1. Current Architecture / المعمارية الحالية

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│         React SPA (Vite + TypeScript + Tailwind)            │
│         Leaflet Maps · Lucide Icons · Motion                │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP (JSON)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Railway (Node 20)                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Express Server (server.ts)                           │  │
│  │  · Helmet (CSP, CORS)                                 │  │
│  │  · Rate Limiting (general + AI)                       │  │
│  │  · Sentry error tracking                              │  │
│  │  · Swagger /api-docs                                  │  │
│  └──┬────────────────────────────────────────────────┬───┘  │
│     │                                                │       │
│     ▼                                                ▼       │
│  ┌─────────────────────┐                  ┌─────────────────┐│
│  │  API Routes         │                  │ Vite Middleware  ││
│  │  /api/reports       │                  │ (dev) or        ││
│  │  /api/admin         │                  │ Static dist/    ││
│  │  /api/satellite-data│                  │ (production)    ││
│  │  /api/ai/guidance   │                  │                 ││
│  │  /api/wilayas       │                  │                 ││
│  │  /api/notifications │                  │                 ││
│  └────┬───────────┬────┘                  └─────────────────┘│
│       │           │                                           │
│       ▼           ▼                                           │
│  ┌────────┐  ┌────────┐                                       │
│  │ Fire-  │  │ Memory │                                       │
│  │ store  │  │(fall-  │                                       │
│  │        │  │ back)  │                                       │
│  └────────┘  └────────┘                                       │
│       │                                                       │
│       ▼                                                       │
│  ┌──────────┐                                                 │
│  │ External │                                                 │
│  │ APIs     │                                                 │
│  │ · NASA   │                                                 │
│  │   FIRMS  │                                                 │
│  │ · Gemini │                                                 │
│  └──────────┘                                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Technology Stack / رصة التقنيات

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 19 + TypeScript | UI |
| **Build** | Vite 6 | Bundler |
| **Styling** | Tailwind CSS 4 | Styling |
| **Maps** | Leaflet (react-leaflet) | Interactive map |
| **Icons** | Lucide React | Icons |
| **Backend** | Express 4 + TypeScript | API server |
| **Runtime** | Node 20 (ESM) | Server runtime |
| **Database** | Firebase Firestore (Admin + Client SDK) | Persistence |
| **Analytics** | NASA FIRMS API | Satellite hotspot data |
| **AI** | Google Gemini (genai SDK) | Report analysis & guidance |
| **Auth** | JWT (jsonwebtoken) | Admin authentication |
| **Validation** | Zod | Input validation |
| **Security** | Helmet + CORS + Rate Limiting | HTTP security |
| **Logging** | Pino | Structured logging |
| **Monitoring** | Sentry | Error tracking |
| **Docs** | Swagger (swagger-jsdoc + swagger-ui-express) | API documentation |
| **Testing** | Vitest + Supertest + Testing Library + Playwright | Testing |
| **Deploy** | Railway | Hosting |

---

## 3. Data Flow / تدفق البيانات

### Report Submission (إرسال بلاغ)
```
User → POST /api/reports → Zod validate → Wilaya bounds check
  → AI vision (if image) → Save to Firestore / Memory
  → Update wilaya status → Response JSON
```

### Report Confirmation (تأكيد بلاغ)
```
User → POST /api/reports/:id/confirm → IP dedup check
  → Firestore transaction (runTransaction) → Update consensusCount
  → Auto-verify if ≥ 5 → Response JSON
```

### Satellite Data (بيانات الأقمار)
```
GET /api/satellite-data → NASA FIRMS API (bbox North Africa)
  → Parse CSV → determineWilayaByCoords → Fallback to preset data → Response JSON
```

### AI Guidance (توجيه الذكاء الاصطناعي)
```
POST /api/ai/guidance → Rate limited (10/hr)
  → Gemini API → Response guidance text
```

---

## 4. Directory Structure / هيكل المشروع

```
observatory/
├── server/                  ← Express API (monolithic)
│   ├── routes/
│   │   ├── admin.ts         ← Admin auth + CRUD
│   │   ├── ai.ts            ← AI guidance
│   │   ├── health.ts        ← Health check
│   │   ├── notifications.ts ← Email subscriptions
│   │   ├── reports.ts       ← Report CRUD + confirm
│   │   ├── satellite.ts     ← NASA FIRMS proxy
│   │   └── wilayas.ts       ← Wilaya status
│   ├── ai.ts                ← Gemini client
│   ├── config.ts            ← Env config
│   ├── data.ts              ← In-memory seed data
│   ├── db.ts                ← Firestore operations
│   ├── email.ts             ← Nodemailer (inactive)
│   ├── firebase.ts          ← Firebase init (Admin + Client)
│   ├── geo.ts               ← Haversine + wilaya bounds
│   ├── logger.ts            ← Pino logger
│   ├── middleware.ts        ← Error handlers
│   ├── server.ts            ← App entry point
│   └── swagger.ts           ← OpenAPI spec
├── src/                     ← React SPA
│   ├── components/
│   │   ├── AdminPanel.tsx
│   │   ├── AICopilot.tsx
│   │   ├── EvacuationRadar.tsx
│   │   ├── InteractiveMap.tsx
│   │   ├── ReportForm.tsx
│   │   ├── SafetyGuides.tsx
│   │   ├── StatisticsPanel.tsx
│   │   └── WilayaList.tsx
│   ├── App.tsx
│   ├── main.tsx
│   ├── types.ts             ← Shared TypeScript types
│   └── index.css
├── tests/
│   ├── api.test.ts
│   ├── geo.test.ts
│   ├── setup.ts
│   ├── components/
│   │   └── admin-panel.test.tsx
│   └── e2e/
├── public/
│   └── sw.js                ← Service Worker
├── assets/
├── .github/
├── .husky/
├── ARCHITECTURE.md          ← This file
├── AGENTS.md                ← AI assistant context
├── Dockerfile
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── vitest.server.config.ts
└── playwright.config.ts
```

---

## 5. Security Architecture / المعمارية الأمنية

| Layer | Mechanism |
|-------|-----------|
| **Transport** | HTTPS (Railway) |
| **HTTP Headers** | Helmet (CSP, XSS, clickjacking) |
| **CORS** | Whitelist origins via `CORS_ORIGINS` |
| **Rate Limiting** | 100 req/min general · 10 req/hr AI |
| **Input Validation** | Zod schemas on all POST endpoints |
| **Auth** | JWT Bearer token for admin routes |
| **Coordinates** | Wilaya bounds validation (server-side) |
| **Voting** | IP-based duplicate detection |
| **Service Worker** | Cache-first for GET only (non-GET pass-through) |
| **XSS** | `esc()` sanitization on HTML template injection |
| **ID Generation** | `crypto.randomUUID()` (not `Date.now()`) |
| **Dependency** | Minimal attack surface; npm audit clean |

---

## 6. Evolution Plan / خطة التطور

### Phase 2 — Monorepo (Next)

Restructure into npm workspaces monorepo:

```
observatory/
├── packages/
│   ├── server/       ← Express API (separated)
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── client/       ← React SPA (separated)
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── shared/       ← Shared types, constants, utils
│       ├── src/
│       │   ├── types.ts
│       │   ├── constants.ts
│       │   └── geo.ts
│       ├── package.json
│       └── tsconfig.json
├── package.json       ← Root workspace config
├── turbo.json         ← Turborepo pipeline
└── ARCHITECTURE.md
```

**Benefits:** Shared types between server/client, independent build/test, clearer separation of concerns.

### Phase 3 — Microservices (Future)

When traffic scales (100k+ req/day) or team grows:

```
┌─────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐   ┌──────────┐
│ Gateway │──▶│ Reports  │──▶│ Satellite│──▶│ AI      │──▶│ Auth     │
│ (Nginx) │   │ Service  │   │ Service  │   │ Service │   │ Service  │
└─────────┘   └──────────┘   └──────────┘   └─────────┘   └──────────┘
                    │               │
                    ▼               ▼
              ┌──────────┐   ┌──────────┐
              │ Firestore │   │ NASA     │
              │          │   │ FIRMS    │
              └──────────┘   └──────────┘
```

Each service: independent Docker image, Railway project, database, rate limits, and deploy cycle.

**Trigger conditions for Phase 3:**
- 🚦 API response time > 500ms consistently
- 🚦 Concurrent users > 1,000
- 🚦 Team size > 3 developers
- 🚦 Need independent scaling (e.g., AI service needs GPU)

---

## 7. Key Decisions / قرارات معمارية

| Decision | Rationale |
|----------|-----------|
| **Monolith first** | Faster iteration, single deploy, lower ops cost. Railway auto-scales. |
| **Firebase** | Serverless, free tier, real-time capable, no DB ops. |
| **Node + Express** | Same language as frontend, huge ecosystem, fast enough. |
| **Zod over class-validator** | Lightweight, TypeScript-first, composable schemas. |
| **JWT over sessions** | Stateless auth, works across potential microservices. |
| **In-memory fallback** | Zero-dependency operation when Firestore unavailable. |
| **Pino over Winston** | Faster, better JSON structured logging. |

---

## 8. Traffic & Scaling / التحمّل والتوسع

| Metric | Current (Monolith) | Phase 3 (Microservices) |
|--------|-------------------|-------------------------|
| **Concurrent users** | ~500 | 10,000+ |
| **Requests/sec** | ~100 | 2,000+ |
| **DB size** | 10k docs | Unlimited (Firestore) |
| **Latency p95** | <200ms | <100ms (with caching) |
| **Deploy time** | ~2 min | ~30 sec per service |

---

*Maintained by Nova DZ · Last updated: July 2026*
