<div align="center">
<img width="120" height="120" alt="Logo" src="https://img.icons8.com/fluency/96/fire-element.png" />
<h1 align="center">المرصد الشمال الإفريقي لحرائق الغابات والكوارث</h1>
<p align="center"><strong>Observatoire Nord-Africain des Feux de Forêt et Catastrophes</strong></p>
<p align="center">North African Wildfire Observatory — Community-Driven Early Warning System</p>

[![CI](https://github.com/DefiAudit0x/wildfire-observatory/actions/workflows/ci.yml/badge.svg)](https://github.com/DefiAudit0x/wildfire-observatory/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)
![React](https://img.shields.io/badge/React-19-61DAFB)
![Express](https://img.shields.io/badge/Express-4.21-green)
![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-1.0.0-orange)

</div>

---

## 📋 Table of Contents / فهرس المحتويات

- [Overview / نظرة عامة](#overview)
- [Features / الميزات](#features)
- [Tech Stack / التقنيات](#tech-stack)
- [Architecture / البنية](#architecture)
- [Getting Started / التشغيل](#getting-started)
- [API Documentation / توثيق API](#api-documentation)
- [Testing / الاختبارات](#testing)
- [Docker](#docker)
- [CI/CD](#cicd)
- [Project Status / حالة المشروع](#project-status)

---

<a name="overview"></a>

## 🌍 Overview / نظرة عامة

**AR:** منصة إنسانية مفتوحة المصدر تهدف إلى إنقاذ الأرواح في المناطق المعرضة لحرائق الغابات في شمال أفريقيا (الجزائر، تونس، المغرب، ليبيا). تعتمد المنصة على الذكاء الاصطناعي (Google Gemini) وبيانات الأقمار الصناعية (NASA FIRMS) والإجماع البشري للتحقق من البلاغات في الوقت الفعلي.

**FR:** Plateforme humanitaire open source visant à sauver des vies dans les zones sujettes aux feux de forêt en Afrique du Nord (Algérie, Tunisie, Maroc, Libye). Elle s'appuie sur l'IA (Google Gemini), les données satellitaires (NASA FIRMS) et le consensus citoyen pour la vérification en temps réel.

---

<a name="features"></a>

## ✨ Features / الميزات

| Feature | Description |
|---|---|
| 🗺️ **Interactive Map** | Real-time wildfire monitoring with Leaflet, satellite hotspots (MODIS/VIIRS) & citizen reports |
| 🤖 **AI Verification** | Google Gemini Vision API analyzes uploaded images for fire/smoke detection |
| 🛰️ **Satellite Data** | Live NASA FIRMS integration for thermal hotspot detection |
| 👥 **Consensus Engine** | Citizen upvoting system — 5+ confirmations auto-verifies a report |
| 📍 **Geo-Clustering** | Automatic grouping of nearby reports within 3km radius |
| 🌐 **Bilingual UI** | Arabic / French interface |
| 📱 **PWA** | Offline support via service worker, installable on mobile |
| 🔐 **Admin Panel** | Secure JWT-based moderation, report management, severity control |
| 🧭 **Compass Triangulation** | Device orientation + GPS + camera alignment for precise reporting |
| 🚨 **Proximity Alerts** | Audio/visual alerts for fires within 30km of user location |

---

<a name="tech-stack"></a>

## 🛠️ Tech Stack / التقنيات

### Frontend
| Technology | Usage |
|---|---|
| React 19 | UI framework |
| TypeScript 5.8 | Type-safe JavaScript |
| Vite 6.2 | Build tool & dev server |
| TailwindCSS 4.1 | Utility-first CSS |
| Leaflet 1.9 | Interactive maps |
| Lucide React | Icons |
| Motion 12 | Animations |
| Sentry React | Error monitoring |

### Backend
| Technology | Usage |
|---|---|
| Node.js 20+ | Runtime |
| Express 4.21 | HTTP server |
| Firebase Firestore | NoSQL database (optional persistence) |
| Google GenAI 2.4 | Gemini AI image verification |
| Helmet | HTTP security headers |
| CORS | Cross-origin resource sharing |
| express-rate-limit | API rate limiting (100 req/min) |
| jsonwebtoken | JWT-based admin authentication |
| Pino 10 | Structured logging |
| Zod 3.24 | Input validation (schemas) |
| Swagger/OpenAPI | API documentation |
| Sentry Node | Error monitoring |

### DevOps
| Technology | Usage |
|---|---|
| Docker | Multi-stage container build |
| GitHub Actions | CI/CD pipeline (lint → test → build) |
| Husky | Pre-commit hooks (tsc --noEmit) |

---

<a name="architecture"></a>

## 🏗️ Architecture / البنية التقنية

```
observatory/
├── server/                    # Express backend
│   ├── server.ts              # Entry point (84 lines)
│   ├── config.ts              # Environment configuration
│   ├── logger.ts              # Pino logger
│   ├── firebase.ts            # Firebase lazy initialization
│   ├── ai.ts                  # Gemini AI client
│   ├── geo.ts                 # Haversine, clustering, wilaya mapping
│   ├── data.ts                # Seed data (reports, hotspots, wilayas)
│   ├── middleware.ts          # JWT auth, error handler
│   ├── swagger.ts             # OpenAPI 3.0 config
│   └── routes/
│       ├── health.ts          # GET /api/health
│       ├── reports.ts         # GET/POST /api/reports, POST confirm
│       ├── admin.ts           # POST /api/admin/verify, update, delete
│       ├── satellite.ts       # GET /api/satellite-data
│       ├── wilayas.ts         # GET /api/wilayas (dynamic stats)
│       └── ai.ts              # POST /api/ai/guidance
├── src/                       # React frontend
│   ├── App.tsx                # Main app with 7 tabs
│   ├── types.ts               # TypeScript interfaces
│   ├── main.tsx               # Entry with Sentry
│   └── components/
│       ├── InteractiveMap.tsx  # Leaflet map with markers
│       ├── ReportForm.tsx      # Citizen report submission
│       ├── AdminPanel.tsx      # Admin moderation dashboard
│       ├── AICopilot.tsx       # AI guidance assistant
│       ├── EvacuationRadar.tsx # Evacuation radar view
│       ├── CrisisCenter.tsx    # Crisis operations center
│       ├── SafetyGuides.tsx    # Safety guides
│       ├── StatisticsPanel.tsx # Wilaya statistics
│       └── WilayaList.tsx      # Region status list
├── tests/                     # Unit tests (14 tests)
│   ├── geo.test.ts            # 9 geo/clustering tests
│   └── api.test.ts            # 5 API endpoint tests
├── public/
│   ├── sw.js                  # Service worker (offline cache)
│   └── manifest.json          # PWA manifest
├── .github/workflows/ci.yml   # CI/CD pipeline
├── Dockerfile                 # Multi-stage production build
└── vitest.server.config.ts    # Vitest config
```

### Verification Pipeline / خط أنابيب التحقق

```
Report Submitted
    │
    ├─► AI Vision (Gemini) ───► confidence >= 75% → auto-verified
    │     (if image provided)
    │
    ├─► Satellite (NASA FIRMS) ──► hotspot within 3km → +confidence
    │
    └─► Human Consensus ──► 5+ confirmations → auto-verified
          (citizen upvoting)
```

---

<a name="getting-started"></a>

## 🚀 Getting Started / التشغيل

### Prerequisites / المتطلبات

- **Node.js** ≥ 20
- **npm** or **bun**

### Installation / التثبيت

```bash
# Clone
git clone https://github.com/DefiAudit0x/wildfire-observatory.git
cd wildfire-observatory

# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your keys:
#   GEMINI_API_KEY — required for AI verification
#   NASA_FIRMS_KEY — optional, for live satellite data
#   ADMIN_PASSWORD — required for admin panel
#   JWT_SECRET — change for production

# Run development server
npm run dev
```

Open http://localhost:3000 in your browser.

### Environment Variables / متغيرات البيئة

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google Gemini API key for AI image verification |
| `ADMIN_PASSWORD` | ✅ | Admin panel password (replaces hardcoded `nova2026`) |
| `JWT_SECRET` | ✅ | Secret key for JWT token signing |
| `NASA_FIRMS_KEY` | ❌ | NASA FIRMS API key for live satellite data |
| `NODE_ENV` | ❌ | `development` or `production` (default: `development`) |
| `PORT` | ❌ | Server port (default: `3000`) |
| `LOG_LEVEL` | ❌ | Pino log level: `info`, `debug`, `warn`, `error` |
| `SENTRY_DSN` | ❌ | Sentry DSN for error monitoring |
| `CORS_ORIGINS` | ❌ | Comma-separated allowed origins |
| `GEMINI_MODEL` | ❌ | Gemini model (default: `gemini-2.0-flash`) |

---

<a name="api-documentation"></a>

## 📖 API Documentation / توثيق API

Full interactive API documentation is available via Swagger UI:

```
http://localhost:3000/api-docs
```

### Endpoints

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/api/health` | Health check | ❌ |
| `GET` | `/api/reports` | List all reports (clustered) | ❌ |
| `POST` | `/api/reports` | Submit a new report | ❌ |
| `POST` | `/api/reports/:id/confirm` | Upvote/confirm a report | ❌ |
| `GET` | `/api/satellite-data` | Get satellite hotspots (NASA FIRMS) | ❌ |
| `GET` | `/api/wilayas` | Get region statistics | ❌ |
| `POST` | `/api/ai/guidance` | AI safety guidance | ❌ |
| `POST` | `/api/admin/verify` | Admin login (returns JWT) | ❌ |
| `POST` | `/api/admin/reports/:id/update-status` | Update report status/severity | ✅ Bearer JWT |
| `POST` | `/api/admin/reports/:id/delete` | Delete a report | ✅ Bearer JWT |

---

<a name="testing"></a>

## 🧪 Testing / الاختبارات

```bash
# Run server unit tests
npm run test:server

# Type check
npm run lint     # (tsc --noEmit)

# Full build
npm run build
```

Current test coverage:
- **14 unit tests** (9 geo + 5 API)
- **0 errors** on `tsc --noEmit`
- **CI pipeline** runs lint → test → build on every push/PR

---

<a name="docker"></a>

## 🐳 Docker

```bash
# Build
docker build -t wildfire-observatory .

# Run
docker run -p 3000:3000 --env-file .env wildfire-observatory
```

Multi-stage build:
1. **Builder stage**: installs dependencies, runs `vite build` + `esbuild`
2. **Production stage**: `node:20-alpine`, `USER node`, only `dist/` + `node_modules`

---

<a name="cicd"></a>

## 🔄 CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`):
1. `npm ci`
2. `npm run lint` (tsc --noEmit)
3. `npm run test:server` (vitest)
4. `npm run build` (vite + esbuild)

Husky pre-commit hook runs `tsc --noEmit` before each commit.

---

<a name="project-status"></a>

## 📊 Project Status / حالة المشروع

| Criterion | Rating |
|---|---|
| Security | 8/10 ✅ (JWT, Helmet, CORS, rate limiting) |
| Code Quality | 7/10 ✅ (modular structure, Pino logging, error handling) |
| Testing | 6/10 ⬆️ (14 unit tests, CI pipeline) |
| Documentation | 7/10 ✅ (Swagger API docs, bilingual README) |
| Architecture | 7/10 ✅ (clean separation, lazy Firebase init) |
| **Overall** | **7/10** |

### What was improved / التحسينات المنجزة

- ✅ **Security**: Replaced hardcoded `nova2026` password with JWT authentication, added Helmet, CORS, rate limiting
- ✅ **Architecture**: Monolithic 1082-line `server.ts` split into 15 modular files
- ✅ **Logging**: `console.log` replaced with Pino structured logger
- ✅ **Error Handling**: Centralized error handler middleware
- ✅ **Testing**: 14 unit tests with Vitest
- ✅ **CI/CD**: GitHub Actions pipeline + Husky pre-commit hooks
- ✅ **API Docs**: Swagger UI at `/api-docs`
- ✅ **Docker**: Multi-stage production build
- ✅ **Monitoring**: Sentry integration (server + React)
- ✅ **PWA**: Service worker with offline API caching
- ✅ **Geo Fixes**: Corrected Tunisia/Libya region boundaries

---

<div align="center">
<p>
  <strong>AR:</strong> مبادرة إنسانية مفتوحة المصدر — <a href="https://facebook.com/groups/1295962545580951/">انضم إلينا</a>
</p>
<p>
  <strong>FR:</strong> Initiative humanitaire open source — <a href="https://facebook.com/groups/1295962545580951/">Rejoignez-nous</a>
</p>
<p>© 2026 Nova DZ</p>
</div>
