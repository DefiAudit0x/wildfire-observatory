# Algerian Wildfire and Disaster Observatory — Architecture

> المعمارية الحالية والمستقبلية لمنصة المرصد الجزائري لحرائق الغابات والكوارث

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
│   ├── manifest.json ← PWA manifest
│   └── favicon.svg   ← App icon
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
| **Service Worker** | Workbox precache for built assets (GET only) · NetworkFirst for `/api/*` with 120s expiry |
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

## 7.b Known Limitations & Honest Gaps / حدود معلنة ونواقص صريحة

Fuel for the ongoing security/protocol audit — nothing here is hidden.

| Area | Status | Notes |
|------|--------|-------|
| **Geofencing precision** | Known limitation | `WILAYA_BOUNDS` covers 22 fine-grained bounding boxes; the remaining wilayas rely on a country-level rectangle fallback (`determineWilayaByCoords`). Boxes can overlap; `find()` takes the first match. Real **GeoJSON polygons** for all wilayas are a pilot-phase task. |
| **Report clustering complexity** | Known limitation | `runClustering` is O(n²) and transitive (A~B, B~C ⇒ cluster even if A~C far). Fine to a few thousand reports; beyond that a spatial index (geohash / H3 / PostGIS) is required. |
| **Duplicate protection** | Known limitation | `recentReports` is in-memory. A race was closed (reservation happens before any `await`), but running **multiple instances** gives each its own window — a distributed Redis/GeoFirestore dedup is required before horizontal scaling. |
| **Mesh E2EE vs. relay** | Open protocol design | A broadcast is encrypted for one "best peer" (per-recipient ECDH). Peer public keys are now learned from signed messages (relays expose `origPublicKey`), but **only the addressed peer can decrypt** — an arbitrary online device D can relay a hop to the API only when it holds the key. The store-and-forward gateway (`src/lib/meshRelay.ts`) enforces PoW + dedup + queue and submits whatever plaintext this device CAN decrypt; full any-to-any relay needs the protocol work below. |
| **Identity ↔ ephemeral binding** | Open protocol design | Messaging signatures use the hourly ephemeral key; the persistent `identityKeyPair` is exposed but **not yet cryptographically bound** to the ephemeral key. A device-authentication handshake (identity-signed ephemeral keys) is on the audit list. |
| **PoW receiving-side enforcement** | Defensive depth | Senders attach PoW; the native relay verifies envelope PoW before submission. The nearby-wire layer currently filters by reputation instead of verifying PoW on every hop. |
| **deviceId as bearer token** | Documented trade-off | The app's device identity (deviceId cookie + mesh token endpoint) is treated as a bearer credential throughout (notifications GET now refuses cross-device fetches). Long-term: real per-device auth or key-based proofs. |

### Mesh protocol audit checklist (خطوة المراجعة القادمة)

- [ ] Peer key exchange handshake (identity-signed ephemeral keys) — see `CryptoEngine.kt` + `MeshService.kt`
- [ ] Hybrid encryption (wrap a random data key per recipient) or signed-plaintext envelope for **report** broadcasts so any relay can forward
- [ ] PoW verification on every incoming relayed hop
- [ ] Unified Transport abstraction: `InternetTransport` (WebSocket MeshHub) · `NearbyTransport` (Android) · `LoRaTransport` (T-Beam/Meshtastic, future) · `StoreAndForwardQueue`

### Audit-deferred decisions / قرارات مؤجلة من دورة التدقيق

| Decision | Current treatment | Why it is deferred |
|----------|-------------------|--------------------|
| **Device ownership / mesh token possession** | `deviceId` remains a bearer-style identifier; HTTP cookie bindings now reject cross-device reuse where the route has a browser session. | Closing first-bind spoofing requires a registration or key-possession protocol shared by browser, Android, and WebSocket clients; cookie binding alone is not proof of physical-device possession. |
| **TOFU reputation continuity** | Reputation remains keyed to the advertised ephemeral public key. | Binding rotating ephemeral keys to the persistent Android identity changes the trust protocol and requires an identity-signed handshake; it was not changed silently in this compatibility pass. |
| **Android Keystore migration of legacy identities** | Existing legacy SharedPreferences identities are preserved for continuity; Keystore is preferred for new installs. | Deleting or migrating the legacy private key without an explicit rollout would rotate device identity and invalidate established trust/history. |
| **Hazard-aware evacuation routing** | The UI reports OSRM distance or a clearly labelled estimate and does not claim fire-safe routing. | Fire polygons, closures, official route advisories, and policy ownership are not present in the current data contract. |
| **OSRM privacy proxy** | The client sends route coordinates directly to the public OSRM endpoint when the user requests a calculation. | A server-side proxy requires a deployment/privacy decision and operational ownership; it was not introduced as an unreviewed data-flow change. |
| **Polygon geofences** | Request-time wilaya validation uses available bounding-box data and rejects unknown declared wilayas. | Authoritative GeoJSON boundaries are required before replacing the current dataset contract. |

| **Badge `maxUses` atomicity** | The report path validates `usedCount < maxUses` and schedules the usage increment separately. | Enforcing the cap under concurrent submissions requires a Firestore transaction or server-side counter reservation, plus a compatibility and failure-recovery plan. It was not silently redesigned in this pass. |
| **Firestore read/error semantics across all callers** | Collection reads now distinguish an empty result (`[]`) from an unavailable/error result (`null`); report reads use a discriminated result. | Remaining route-specific helpers still expose boolean/null outcomes. A repository-wide result contract is needed before changing every fallback and HTTP status consistently. |
| **Admin Firestore fallback to RAM** | Admin report update/delete can fall back to the in-memory dataset when Firestore returns `false`, preserving the existing no-Firestore development mode. | Treating a persistence failure as a successful RAM-only mutation can diverge from production state. Replacing it requires a discriminated write result and an explicit operational policy. |
| **Confirmation Firestore fallback to RAM** | Report confirmation falls back to the in-memory voter ledger when `confirmReportInFirestore` returns `null`. | A transient Firestore failure can make a confirmation appear successful locally without durable consensus. A strict fail-closed mode or an explicit offline policy requires product and deployment decisions. |
| **Central Command password policy** | Central Command routes currently share the `requireAdmin` token and the admin verifier accepts the configured bcrypt hash, with a legacy password compatibility path. | Whether Central Command must be restricted to a separate super-admin role is an authorization-policy decision, not a safe compatibility fix. |
| **HKDF key derivation** | The current E2EE derivation uses the protocol's existing SHA-256 construction. | Migrating to HKDF would improve domain separation but changes derived keys and requires a versioned migration/handshake; it was intentionally not changed silently. |
| **BLE capability policy** | `android.hardware.bluetooth_le` is currently declared as required by the Android manifest. | Choosing a graceful no-BLE mode versus keeping BLE mandatory is a product and distribution decision; changing the manifest affects device eligibility and fallback UX. |
| **Consensus voter identity** | Browser confirmations combine the request IP with a supplied device identifier, while native/storage paths keep their existing voter records. | Strong voter possession proof or a stable authenticated identity is required to make consensus resistant to identity spoofing without breaking anonymous field use. |
| **Mesh Relay DLQ retention** | Pending relay items are capped at 50. Capacity overflow moves the oldest *unprotected* pending item to an independent DLQ only when that transition persists; items with co-located journal state `prepared` or `delivered` are protected from eviction. If no evictable item exists, the new relay item is rejected as `queue_capacity_protected`; if the DLQ transition cannot persist, it is rejected as `dead_letter_unavailable`. | DLQ retention duration, storage budget, monitoring, export, and deletion procedure are operational policy decisions. No implicit FIFO trimming is permitted before that policy is configured and reviewed. |

### 7.c Durable Reconciliation Journal for Mesh Relay / سجل مصالحة التسليم الدائم

> **قرار معتمد قبل التنفيذ:** Relay delivery لا يعتمد على RAM لتقرير مصير بلاغ استلم الخادم له استجابة نجاح. إذا فشل حفظ queue بعد استجابة نجاح ثم حدث reload أو crash، يجب أن تسمح البيانات الدائمة بإعادة بناء queue من دون إعادة إدخال البلاغ المسلَّم إلى pending.

هذا العقد محصور في `src/lib/meshRelay.ts` وطبقة التخزين المحلية للـrelay. لا يغيّر badge `maxUses` أو Firestore consensus أو بروتوكول Mesh أو API الخادم. يعتمد recovery على `clientGeneratedId` الموجود أصلًا في API كمعرّف idempotency؛ لذلك يجب أن يحمل كل `QueuedRelay` قابل للإرسال معرّفًا ثابتًا صالحًا. يحتفظ الـrelay بالمعرّف الوارد كما هو، وإذا غاب يُنشئه مرة واحدة قبل أول journal `prepared` ويخزنه مع التقرير لإعادة استخدامه في كل محاولة لاحقة. هذا استعمال لحقل API اختياري قائم، لا عقد endpoint جديد.

#### Journal record / سجل journal

كل سجل يمثل **عنصر queue واحدًا** لا batch كاملًا، ويُخزّن بجوار نسخة الـqueue التي يحميها؛ لا يجوز تطبيق journal من IndexedDB على snapshot من localStorage أو العكس. يضم السجل، كحد أدنى، `journalId` و`queueItemId` و`storageReplica` و`baseQueueRevision` و`clientGeneratedId` و`reportFingerprint` ونسخة التقرير اللازمة لإعادة المحاولة ووقت الإنشاء والتحديث وبيانات المحاولة. عند تسجيل التسليم يضاف `deliveredAt` و`deliveryDisposition` (`http_200` أو duplicate terminal مصنّف) ووصف transition المتوقع: إزالة `queueItemId` من pending مع بقاء بقية pending وDLQ كما هي أو وفق الانتقالات المسجلة لها.

| حالة السجل | المعنى | أثر recovery |
|---|---|---|
| `prepared` | intent دائم كُتب قبل استدعاء `submitRelay()`؛ النتيجة الشبكية غير مؤكدة بعد. | يبقى المصدر pending ويعاد الإرسال بالـ`clientGeneratedId` نفسه وفق backoff؛ لا يجوز إنشاء ID جديد. |
| `delivered` | وردت استجابة نجاح أو duplicate terminal ثم حُفظ outcome بشكل دائم؛ queue transition قد لا يكون حُفظ بعد. | يعاد بناء queue مع إزالة العنصر المسلَّم حتى لو كانت snapshot الدائمة قديمة. |
| `committed` | أصبحت queue المعاد بناؤها durable وتثبت إزالة delivered IDs وأي انتقال DLQ مرتبط. | لا يشارك السجل في الإرسال أو reconstruction بعد التحقق من commit؛ يحتفظ به إلى أن توجد سياسة حذف صريحة. |

#### Write and recovery lifecycle / دورة الكتابة والاسترداد

يكتب الـrelay سجل `prepared` durable **قبل** أي طلب HTTP. إذا نجحت الكتابة فقط، يستدعي `submitRelay()`؛ وبذلك لا يمكن أن تنجح الشبكة بلا أثر دائم لخطة التسليم. عند استجابة نجاح أو duplicate terminal، يرقّي السجل إلى `delivered` durable قبل محاولة إزالة العنصر من queue. عند فشل HTTP أو غموض النتيجة، يبقى `prepared` وتستمر queue/backoff؛ إعادة المحاولة تستخدم الـ`clientGeneratedId` نفسه وتستفيد من idempotency الخادم القائمة بدل افتراض أن الطلب لم يصل.

عند إعادة تحميل الصفحة أو استئناف التطبيق، يعاد بناء كل نسخة durable بصورة مستقلة: queue snapshot مع journal co-located معها، ثم تطبق سجلات `delivered` بصورة idempotent بإزالة `queueItemId` المطابق و`reportFingerprint` المطابق من pending. لا يمزج recovery journal من replica مع queue replica أخرى. بعد reconstruction تختار آلية revision النسخة المعاد بناؤها ذات revision الأعلى كما تفعل queue حاليًا؛ ثم تكتب queue الناتجة durable وتحوّل سجلاتها المنطبقة إلى `committed`.

لـIndexedDB، يكون تحديث queue+journal ضمن transaction واحدة حين يتاح ذلك. ولـlocalStorage fallback، يكون الترتيب recoverable: `prepared/delivered` أولًا، ثم queue snapshot، ثم `committed`. إذا وقع crash بين هذه الخطوات، يعيد recovery تطبيق journal بدل إعادة التقرير المسلَّم. لا يحذف journal قبل تحقق هذه العلاقة الدائمة.

#### Commit, deletion, and failure handling / الالتزام والحذف والفشل

السجل `delivered` لا يتحول إلى `committed` إلا إذا أثبتت نسخة queue الدائمة أن `queueItemId` أزيل من pending وأن انتقالات DLQ الأخرى ما زالت ممثلة. إذا نجحت كتابة queue وفشل تعليم السجل `committed`، يبقى السجل ويكون recovery idempotent؛ لا تعود الرسالة إلى pending. لا يجوز حذف سجل `committed` إلا بعد تحقق commit الدائم **وبموجب retention/deletion policy تشغيلية صريحة لاحقة**. لا تضيف هذه المرحلة أي مدة أو حد حجم أو FIFO trimming للـjournal أو DLQ.

| موضع الفشل | السلوك الإلزامي |
|---|---|
| تعذّر حفظ `prepared` | لا يستدعى `submitRelay()`؛ يبقى pending وDLQ بدون تغيير ويسجل failure قابل للرصد. |
| فشل/غموض HTTP بعد `prepared` | يبقى `prepared` وpending؛ يعاد الإرسال بالـ`clientGeneratedId` نفسه، لا بمعرّف جديد. |
| نجاح HTTP وتعذّر حفظ `delivered` | لا يزال `prepared` قائمًا ولا تزال queue غير محذوفة؛ لا يدّعي العميل التسليم الدائم. recovery يعيد المحاولة idempotently. |
| `delivered` محفوظ وتعذّر حفظ queue transition | يبقى `delivered` durable؛ recovery يزيل العنصر من reconstruction ولا يعيد إرساله. |
| queue محفوظ وتعذّر تعليم/تنظيف `committed` | يبقى السجل؛ recovery يتحقق من queue commit ولا يعيد إدخال العنصر أو إرساله. |

#### Required invariants and implementation tests / الثوابت والاختبارات المطلوبة

| Invariant | اختبار implementation المطلوب |
|---|---|
| لا يبدأ HTTP dispatch بلا `prepared` durable. | فشل journal قبل الإرسال يمنع استدعاء `fetch` ويحافظ على pending. |
| لا تضيع نتيجة `delivered` قبل أن تصبح queue transition durable. | نجاح HTTP ثم فشل queue persistence ثم reset module يعيد بناء queue من دون إعادة إرسال التقرير. |
| `prepared` يعالج النتيجة الغامضة بأمان. | crash بعد dispatch وقبل `delivered` يعيد المحاولة بنفس `clientGeneratedId` فقط. |
| DLQ source لا يحذف إذا لم يثبت انتقاله، وdelivered IDs لا تعود pending. | flush مختلط (success + dead-letter) مع فشل persistence ثم reload يعيد مصدر DLQ وحده ولا يعيد delivered ID. |
| journal-protected pending لا يُنقل إلى DLQ بسبب capacity overflow. | overflow مع `prepared` أو `delivered` يحمي العنصر؛ وإذا كانت كل pending محمية يعيد الإدخال `queue_capacity_protected` دون تعديل queue أو DLQ. |
| recovery لا يخلط نسخ التخزين. | IndexedDB/localStorage يحملان revisions مختلفة وسجلين مختلفين؛ يعاد بناء كل replica مع سجلها ثم تطبق precedence. |
| `committed` لا يمسح ضمنيًا. | crash بعد queue commit وقبل journal finalization لا يعيد إرسال العنصر ولا يحذف السجل تلقائيًا. |

**حد العقد:** journal يمنع فقدان knowledge المحلي عن استجابة نجاح ويحوّل إعادة المحاولة الغامضة إلى retry ثابت المعرف. لا يدّعي distributed exactly-once بين المتصفح والخادم؛ سلامة retry بعد failure غامض تعتمد على idempotency الحالية لـ`clientGeneratedId`. أي تغيير لاحق في مدة idempotency الخادم أو retention/deletion للـjournal يحتاج قرار policy منفصل.

### 7.d Replay Admission Reservation for Mesh Relay / حجز قبول replay

> **قرار معتمد قبل التنفيذ:** replay admission حجز مؤقت داخل الجلسة يمنع نسخ الـraw envelope المتزامنة من دخول queue معًا. لا يصبح هذا الحجز نتيجة تسليم ولا جزءًا من Durable Reconciliation Journal؛ لا بد أن يُفرج عنه إذا رفضت queue admission التقرير قبل أن يصبح عنصر queue مقبولًا.

بعد PoW وpayload validation، ينشئ الـrelay reservation للـhash مع ownership token فريد. إذا أعادت `enqueueRelay()` قبولًا (`accepted: true`) يبقى الحجز حتى انتهاء نافذة replay المعتادة، لأن التقرير صار داخل queue/journal lifecycle. إذا أعادت رفضًا (`accepted: false`، مثل `queue_capacity_protected` أو `dead_letter_unavailable`) يحرر الـrelay الحجز **فقط** عند مطابقة hash وownership token نفسهما. لا يحرر أي فشل يقع بعد queue admission، بما في ذلك فشل HTTP أو `prepared` أو `delivered` أو retry.

| Invariant | اختبار implementation المطلوب |
|---|---|
| الحجز يمنع duplicate متزامن أثناء admission. | المحاولة الثانية لنفس raw خلال حجز A تُرفض قبل enqueue. |
| rejection لا يحرم raw من retry لاحق. | `queue_capacity_protected` و`dead_letter_unavailable` يحرران حجز A ثم تقبل محاولة C لاحقة بعد recovery. |
| stale release لا يمسح reservation أحدث. | بعد فشل A وحجز B للـhash ذاته، `release(H, tokenA)` لا يحرر `tokenB`. |
| القبول volatile يبقي الحجز. | enqueue بقبول volatile لا يحرر hash، لأن التقرير أصبح ضمن delivery lifecycle. |
| أخطاء delivery لا تغير admission reservation. | فشل HTTP أو `prepared` بعد قبول queue يبقي الحجز طوال retention window. |

**حد العقد:** الحجز الحالي in-memory ولا يدوم عبر reload/crash؛ reset للجلسة يزيله كما يزيل cache replay الحالي. لا يضيف هذا القرار retention دائمًا أو بروتوكول Mesh جديدًا أو API جديدًا أو حلًا لفجوة origin `clientGeneratedId`.
---

### 7.e Strict Origin `clientGeneratedId` / هوية المنشأ الصارمة

> **قرار معتمد:** `clientGeneratedId` هو هوية التقرير عبر كامل delivery lifecycle، وليس هوية relay أو queue أو journal. كل report Mesh جديد يجب أن يحمل هذا المعرّف قبل دخوله إلى relay.

يُنشئ المصدر المعرّف مرة واحدة قبل أول POST أو broadcast ويحافظ عليه عبر كل Mesh hop وretry. يمرره relay والخادم دون تعديل. إذا غاب المعرّف أو كان غير صالح، يرفض relay الرسالة قبل replay reservation وقبل queue وjournal وHTTP، مع سبب قابل للرصد؛ لا ينشئ relay معرّفًا بديلًا.

على الخادم، تكون idempotency keyed by `clientGeneratedId` دائمة وذرية مع إنشاء التقرير: transaction تقرأ سجل المفتاح، فإن وجدته تعيد التقرير الأصلي؛ وإن لم تجده تكتب report وسجل idempotency معًا. لا يجوز تنفيذ check ثم create في عمليتين منفصلتين. طلبان متزامنان بالمعرّف نفسه يجب أن ينتجا report دائمًا واحدًا فقط، ويعيد الطلب الخاسر النتيجة الملتزم بها.

لا يدّعي هذا القرار exactly-once أو durable idempotency عند تعذر Firestore؛ semantics ذلك الفشل مؤجلة إلى قرار مستقل. كما أن Same ID مع body مختلف يُكتشف ويُصنف بواسطة fingerprint، لكن response semantics ليست جزءًا من هذا القرار. replay cache المحلي يبقى طبقة anti-replay مستقلة، وDurable Reconciliation Journal يبقى مسؤولًا عن recovery المحلي ولا يستبدل هوية المنشأ.

هذا القرار لا يغير badge `maxUses` أو consensus أو DLQ أو journal lifecycle أو replay retention أو Mesh cryptography. أي دعم لرسائل legacy بلا origin ID خارج strict A1 يحتاج قرار توافق مستقل، وليس fallbackًا صامتًا.

#### A1 execution decision: canonical fingerprint reuse

نفس `clientGeneratedId` مع نفس canonical fingerprint يعيد النتيجة الأصلية، ونفس المعرّف مع fingerprint مختلف يعيد `409 IDEMPOTENCY_KEY_REUSE` دون report جديد أو overwrite لسجل المفتاح. يُحسب fingerprint من canonical normalized request representation ثابتة الإصدار، ثم SHA-256؛ لا يُستخدم raw HTTP body. التمثيل الحالي يشمل الحقول التي تعبر Mesh: `lat` و`lng` و`locationName` و`wilaya` و`description` و`severity` و`reporterType` بعد normalization، ويُحفظ digest الأصلي مع سجل idempotency. Firestore unavailable semantics تبقى خارج هذا القرار.

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


#### A1 execution decision: Q1 legacy pending quarantine

بعد تفعيل strict origin boundary، قد تبقى في مخزن relay عناصر `pending` محفوظة من نسخة سابقة وتفتقد `clientGeneratedId` صالحًا. هذه العناصر غير قابلة للإرسال ضمن A1 ولا يجوز أن تبقى عالقة أو أن يُخترع لها معرّف بديل.

عند `flush`، يُنقل العنصر legacy إلى **DLQ الموجود حاليًا** مع `deadLetter: true` و`lastError: "missing_origin_client_generated_id"` و`deadLetteredAt`، ثم يُزال من `pending`. لا يحدث له HTTP submission أو journal preparation أو retry جديد، ويُسجّل الحدث عبر structured/error logging. هذا استخدام quarantine لأثر legacy فقط، ولا يغيّر DLQ lifecycle أو retention أو capacity policy العامة.

إذا تعذرت persistence لانتقال DLQ، لا يُحذف العنصر صامتًا؛ ترث العملية semantics فشل DLQ الحالية، أي يبقى المصدر محفوظًا pending/volatile وفق مسار reconciliation الحالي إلى أن تصبح persistence ممكنة. لا استعادة ولا توليد لـ`clientGeneratedId`، ولا fallback إلى cache أو limited scan.

يبقى العنصر legacy الذي يملك origin ID صالحًا ضمن المسار الطبيعي. أما أي enqueue جديد بلا ID أو بـID غير صالح فيُرفض قبل replay reservation وqueue وjournal وHTTP بسبب `missing_origin_client_generated_id`.

#### A1 execution boundary: Admin-only durable path
يدعم L1 lazy transactional backfill خادم Firestore Admin فقط، لأن query داخل transaction جزء من read-set في Admin SDK. لا يدّعي Client Web SDK دعم L1، ولا تستخدم query خارج transaction ثم create داخلها كبديل. عند غياب Admin durable path، يعيد route failure صريحًا `DURABLE_IDEMPOTENCY_UNAVAILABLE` ولا يدعي exactly-once أو durable idempotency.

#### SOS identity binding boundary
القيمة `deviceId` في SOS هي UUID مولدة محليًا، وcookie `sos_device_id` تربط الجلسة بهذه القيمة لمنع تبديل المعرّف العرضي داخل المتصفح. هذه **ليست مصادقة جهاز أو إثبات ملكية cryptographic**، ولا يجوز استخدامها لإسناد هوية قانونية للمستخدم أو منح صلاحيات حساسة. حماية profile الحالية هي session binding وخصوصية تخزين مشفر فقط.

أي ترقية إلى مصادقة حقيقية تتطلب قرارًا معماريًا منفصلًا يحدد نموذج الهوية والتعافي وتبديل الأجهزة، مثل حساب موثق أو مفتاح جهاز محفوظ مع إثبات توقيع وتدفق استرداد صريح. لا يغيّر هذا التوثيق مسار SOS الطارئ الحالي، ولا يدّعي إصلاح F-008 دون ذلك القرار.
