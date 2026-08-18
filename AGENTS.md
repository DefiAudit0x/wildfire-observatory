# AGENTS.md — مشروع المرصد الجزائري لحرائق الغابات والكوارث

إرشادات للمساعدين الآليين (والبشر) عند العمل في هذا المستودع.

## الأوامر الأساسية
- `npm run lint` — فحص الأنواع: `tsc --noEmit` (دقيق وصارم، strict تشغيل)
- `npm run build` — `vite build` ثم `esbuild server/server.ts` → `dist/server.cjs` (حزم الخادم بـ `--packages=external`: يتطلب `node_modules` وقت التشغيل)
- `npm run test:server` — اختبارات الخادم (Vitest، بيئة node، `SKIP_FIREBASE=true` تلقائياً، الملفات `tests/**/*.test.ts`)
- `npm run test:react` — اختبارات المكونات (jsdom، `tests/**/*.test.tsx`)
- `npm run test:e2e` — Playwright (Chromium، 16+ اختبار؛ **أوقف أي خادم على :3000 قبل التشغيل** وإلا يفشل بـ 429/إعادة استخدام)

## سير العمل بعد أي تعديل
1. `npm run lint` → 2. `npm run build` → 3. `npm run test:server` → 4. `npm run test:react` → 5. `npm run test:e2e` → 6. commit + push (الرسائل بالإنكليزية، نمط conventional `fix(...)/feat(...)`)

## ملاحظات معمارية حرجة
- **الخادم والواجهة يتشاركان الأنواع**: `src/types.ts` مستوردة من `server/*.ts` — أي تغيير في نوع عام يؤثر على الطرفين.
- **قاعدة البيانات**: Firestore (firebase-admin أو client SDK) عبر `server/firebase.ts` — غائبة في CI والـ e2e بـ `SKIP_FIREBASE=true`؛ عندها تُستخدم بيانات البذرة `server/data.ts`. لا تكتب اختبارات تعتمد على DB حقيقية.
- **حد المعدل**: `/api/*` مجمعاً 100/60s (`server.ts`)، مفاتيح إضافية لكل نقطة (AI 10/ساعة، SOS 2/دقيقة، heartbeat 30/دقيقة + حد شارات). اختبارات الـ limiter تُعزل بـ XFF.
- **التعقيم**: PII تُعقم في `server/sentry-scrub.ts`؛ مدخلات AI عبر `sanitizeForPrompt` (استبدال بـ `[بيانات المستخدم]`، لا حذف).
- **الصلاحيات**: تتطلب `requireAdmin` (كوكي admin_token) — تقريباً كل مسارات `/api/admin/*`, `/api/roster/*`, `/api/units/*`, `/api/auth/*` الموظفين، `/api/badges` للكتابة.
- **الواجهة**: Angular-less React 19 + Tailwind 4؛ التقسيم الكسول موجود (InteractiveMap/RosterBoard/CentralCommand/AdminPanel); لا تُضف مكتبات ثقيلة بلا سبب (رفضنا clustering بـ 500kB لأن الخادم يجمع من 3كم).

## المستندات المرتبطة
- `ARCHITECTURE.md` — تصميم النظام والمسارات
- `DATA_SOURCES.md` — مصدر كل بيانات (FIRMS/Open-Meteo/OSRM/الخرائط/Firestore)
- `README.md` — الاستخدام والتشغيل (ادعاءات الزمن: **Near-real-time**، لا «Real-time» — صراحة بخصوص `isFallback`)

## قواعد أمنية ثابتة
- لا تُسرب أسراراً: `firebase-applet-config.json` مستثنى من git وdocker (يُمرَّر وقت التشغيل)؛ الروابط في error messages لا تتضمن tokens.
- لا تستخدم `any` في الأنواع الجديدة؛ النمط المشترك هو وسم discriminated unions (`ReportsDbResult`).
