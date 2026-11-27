# قوالب CV / LinkedIn — جاهزة من مشروع «المرصد الجزائري لحرائق الغابات والكوارث»

> املأ الحقول بين `{{ }}` بمعلوماتك الشخصية. هذا ملف ثابت؛ أدخل أعداد الاختبارات يدوياً من تشغيل موثق وحديث، وسجّل تاريخ التشغيل. احذف أي إنجاز لا يعكس مساهمتك الفعلية.

## نبذة (Summary)

مطوّر Full-Stack + مساهم بقاعدة بيانات حقيقية لحالات الطوارئ: بنيت منصة مفتوحة المصدر لرصد حرائق الغابات والكوارث في شمال أفريقيا (React 19 + TypeScript + Node/Express + Firestore) بواجهة عربية/فرنسية ومراقبة أربع دول (الجزائر وتونس والمغرب وليبيا)، مع تحليل استشاري بالذكاء الاصطناعي (Gemini Vision) لصور البلاغات، اندماج بيانات الأقمار (NASA FIRMS near-real-time)، شبكة Mesh لا مركزية، PWA أوفلاين، ومركز قيادة بصلاحيات موثقة — مع ‏{{N}} اختباراً أتوماتيكياً (وحدات+API+E2E) وخط CI كامل.

## النقاط الأثرية (ابدأ منها في المقابلة)

1. **أمن تطبيقي عملي**: منعت انتحال هوية المتطوعين في نبضات الموقع عبر حدود معدل متعددة (IP/جهاز/شارات متميزة)؛ عزلت هجمات حقن الـ prompt في مساعد AI (استبدال بـ`[بيانات المستخدم]` بدل الحذف)؛ شفّرت بيانات PII للمتطوعين بـ AES-GCM؛ عقمّت الحمولات قبل Sentry (`server/sentry-scrub.ts`).
2. **أداء وهندسة**: خفّضت عواصف 429 بإصلاح طبقة الحد المجمع وإعادة جدولة الاقتراع بموقّت ذاتي مستقر؛ فصّلت حِزم الواجهة (leaflet/sentry/vendor) مع تحميل كسول للمكونات الثقيلة؛ خفّضت ذاكرة الخادم لنداءات SOS من سقف 500→200 عنصر مع تنظيف دوري.
3. **موثوقية**: عرض عدم توفر FIRMS/Open-Meteo بوضوح واستخدام تقدير مسافة/زمن موسوم عند تعطل OSRM؛ وثّقت «Near-real-time» بدل ادعاءات «Live» — صدق بيانات قابل للتدقيق.
4. **جودة**: ‏{{N}} اختبار (Vitest server ‏{{M}} / React ‏{{R}} / Playwright E2E ‏{{K}}؛ أدخل المتخطى إن وجد من نفس التشغيل) + CI (lint→build→tests→E2E) + Docker متعدد المراحل؛ توثيق API يدوي.

## المهارات (Skills)

- Typescript (strict)، React 19، Tailwind 4، Vite/ESBuild
- Node.js/Express، WebSockets (Mesh وأحداث `/api/live`)، rate limiting، JWT/Cookies آمنة
- Firestore (admin + client)، اختبار: Vitest/Supertest/Playwright
- CI: GitHub Actions، Docker، PWA/Service Worker، Sentry

## عنوان مقترح (LinkedIn Headline)

`Full-Stack Developer | React · Node · TypeScript | Wildfire/SafetyTech Open Source`

## مشروع (Project Display)

**المرصد الجزائري لحرائق الغابات والكوارث** — [`github.com/DefiAudit0x/wildfire-observatory`](https://github.com/DefiAudit0x/wildfire-observatory)

- منصة عربية/فرنسية مفتوحة: خريطة تفاعلية، بلاغات بالصور مع تحليل Gemini الاستشاري، مؤشر خطر 0-100، تصدير CSV/GeoJSON مفتوح، مركز قيادة للمشرفين، SOS صوتي مشفّر، شبكة Mesh.
- ‏{{N}} اختباراً أتوماتيكياً، E2E أوفلاين عبر Service Worker، وDocker بسطح تشغيل متعدد المراحل.
