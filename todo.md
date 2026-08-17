# Replay wrapper and origin identity architecture audit

- [x] حصر جميع callers لـ`checkAndRecordRelayHash()` وتصنيف استخداماتهم: لا توجد callers إنتاجية؛ الاستخدام الوحيد اختبار سعة fail-closed.
- [x] تحديد lifecycle الحالي لـorigin envelope و`clientGeneratedId` والـjournal وserver deduplication.
- [x] إعادة إنتاج reload مع envelope بلا origin ID والتحقق من أثر server restart: المعرف المحلي يتغير بعد صفّ فارغ وreload، ومع restart للخادم لا يبقى سوى التقرير الدائم تحت المعرف السابق.
- [x] صياغة خيارات protocol-level ID وdurable local mapping وserver durable deduplication في مسودة قرار مستقلة.
- [x] عرض Architecture Decision دون تعديل production code أو إنشاء commit.

- [x] مراجعة مسودة Architecture Decision مقابل عقد A1 المعتمد وإزالة أي غموض.
- [x] تحديد transaction semantics لسجل idempotency المرتبط بإنشاء التقرير.
- [x] تحديد semantics الاختبارية لـSame ID + different body دون اتخاذ قرار Firestore المؤجل.
- [x] تحديد نطاق تغييرات A1 وregressions المطلوبة دون تعديل production code قبل الموافقة.
- [x] انتظار موافقة صريحة على العقد التنفيذي قبل implementation أو commit أو push.

### Historical audit decision

- [x] اعتماد A1 — Strict Origin `clientGeneratedId` من المستخدم.
- [x] إبقاء Firestore failure semantics وSame ID + different body خارج قرار A1 حتى تُحسم سياساتهما صراحة.
- [x] منع أي production code أو commit أو push في مرحلة تصميم العقد.

### A1 implementation gate

- [x] إضافة origin ID إلزامي في قبول Mesh الجديد دون توليد relay بديل.
- [x] تنفيذ server-side atomic idempotency keyed by `clientGeneratedId` مع transaction Admin/Client، canonical fingerprint، و409 mismatch.
- [x] إضافة regressions لـorigin→relay→HTTP، duplicate relays، crash/reload، legacy rejection، concurrent transaction، وID reuse.
- [ ] تشغيل validation الكامل بعد موافقة التنفيذ.
- [ ] إنشاء commit مستقل وعرض SHA والdiff قبل أي push.
- [ ] انتظار موافقة push منفصلة.

---

## A1 contract review notes

- Origin `clientGeneratedId` هوية التقرير عبر كل delivery lifecycle، وليس queue/session ID.
- يجب أن يمر ID دون تعديل عبر Mesh hops وrelay وHTTP.
- envelope الجديد الذي يفتقد ID يُرفض قبل queue وjournal وHTTP مع سبب قابل للرصد.
- server idempotency يجب أن تكون atomic مع إنشاء التقرير، لا check-then-create منفصلتين.
- نفس ID مع body مختلف يبقى ضمن عقد منفصل؛ يجب اختباره وتوثيقه دون افتراض semantics.
- Firestore unavailable لا يملك exactly-once أو durable idempotency ضمن A1 وحده.
- local replay protection تبقى طبقة مستقلة ولا تُستخدم كبديل عن server idempotency.
- [x] توثيق العقد التنفيذي النهائي في `ARCHITECTURE.md` بعد المراجعة وقبل التنفيذ.
- [x] عدم تعديل production code قبل موافقة المستخدم على العقد التنفيذي.
- [ ] عدم إنشاء commit أو push قبل بوابات الموافقة المحددة.

## A1 implementation scope proposal

- [ ] مراجعة `buildRelayedPayload()` وrelay ingress لفرض origin ID قبل admission.
- [ ] مراجعة `relayReportWithClientGeneratedId()` وإزالة توليد relay البديل أو جعله unreachable للرسائل الجديدة.
- [ ] مراجعة server report persistence ونموذج Firestore المطلوب للسجل الذري.
- [ ] تحديد ما إذا كان العقد يحتاج schema/index/migration قبل أي code change.
- [ ] كتابة regressions قبل implementation وفق acceptance gates المعتمدة.
- [ ] تشغيل focused tests ثم full validation بعد implementation فقط.
- [ ] عرض التغييرات محليًا للمراجعة قبل commit.
- [ ] انتظار approval منفصل قبل push.

## A1 explicit non-scope

- [x] لا تغيير في badge `maxUses`.
- [x] لا تغيير في Firestore failure policy العامة.
- [x] لا تغيير في Mesh cryptography أو replay retention.
- [x] لا تغيير في DLQ أو journal lifecycle إلا إذا أثبت contract dependency مباشرًا.
- [x] لا تغيير في API semantics الخاصة بـSame ID + different body قبل قرار مستقل.
- [x] لا push في مرحلة التصميم.

## A1 test matrix

- [ ] valid origin ID survives source→mesh→relay→HTTP unchanged.
- [ ] duplicate delivery from two relays creates one durable report.
- [ ] reload/server restart preserves same origin ID and returns original result.
- [ ] missing origin ID is rejected before queue/journal/HTTP.
- [ ] local replay protection remains active independently.
- [ ] Same ID + different body is observed and classified without invented policy.
- [ ] Firestore unavailable does not claim durable exactly-once semantics.
- [ ] concurrent first submissions exercise the same atomic idempotency path.
- [ ] malformed/invalid origin IDs are rejected at the boundary.
- [ ] full validation remains clean after implementation.

## A1 delivery gates

- [ ] implementation review complete.
- [ ] focused regressions pass.
- [ ] full validation pass/fail/unavailable recorded.
- [ ] local commit SHA and diff presented.
- [ ] explicit push approval received.
- [ ] remote branch and commit verified after push.

## A1 open questions requiring explicit decision

- [ ] Same ID + different body response semantics.
- [ ] Firestore unavailable behavior for new reports.
- [ ] Legacy non-ID envelope handling outside strict A1.
- [ ] Idempotency record schema and retention if not co-located with report.
- [ ] Whether origin ID uniqueness is enforced by report document key or a dedicated transactionally written record.
- [ ] Exact error code for missing origin ID.
- [ ] Exact error code for ID reuse with different canonical body.
- [ ] Whether a protocol version field is needed for strict rollout.

## A1 review status

- [x] User approved A1 Strict `clientGeneratedId`.
- [x] Contract review completed.
- [x] Transaction semantics approved.
- [x] Implementation scope approved.
- [x] Implementation started.
- [ ] Implementation completed.
- [ ] Commit approved.
- [ ] Push approved.

## A1 evidence inventory

- [x] `src/lib/meshRelay.ts` origin ID generation and ingress path reviewed.
- [x] `src/hooks/useObservatoryData.ts` source ID generation and mesh allow-list reviewed.
- [x] `server/routes/reports.ts` in-memory and durable idempotency lookup reviewed.
- [x] `server/db.ts` report persistence and cache behavior reviewed.
- [x] `tests/mesh-relay.ingress.test.ts` current reload coverage reviewed.
- [x] `tests/api.test.ts` current same-ID idempotency coverage reviewed.
- [x] focused existing tests: 12/12 passed using local Vitest binary.
- [x] `pnpm exec vitest` attempt was not used as validation because pnpm attempted dependency installation and exited on ignored build scripts.
- [x] no production code changed during architecture review.
- [x] no commit created during architecture review.
- [x] no push performed during architecture review.

## A1 next action

- [ ] Present reviewed transaction contract and implementation scope to the user.
- [ ] Wait for explicit approval before modifying `ARCHITECTURE.md` or production code.
- [ ] After approval, update this TODO before each implementation group.
- [ ] After each completed feature, mark its item `[x]` before checkpoint.
- [ ] Before checkpoint, re-read the full TODO and verify all claimed completed items.

## A1 completion criteria

- [ ] Strict origin ID enforced at the new Mesh ingress boundary.
- [ ] Relay no longer invents a replacement origin ID for strict messages.
- [ ] Server idempotency is transactionally atomic with report creation.
- [ ] Concurrent duplicate origin submissions converge to one durable report.
- [ ] Crash/reload/server restart regression passes.
- [ ] Legacy missing-ID behavior is explicit and observable.
- [ ] Same-ID different-body remains explicitly classified.
- [ ] Firestore unavailable semantics remain honestly reported.
- [ ] Full validation completed.
- [ ] Commit reviewed and approved.
- [ ] Push separately approved and remotely verified.

## A1 audit trail

- [x] A1 selected by user.
- [x] A1 strictness selected by user.
- [x] No silent architecture redesign allowed.
- [x] No push without explicit approval.
- [x] Contract implementation approval received.
- [ ] Commit approval pending.
- [ ] Push approval pending.

## A1 file scope candidates

- [ ] `ARCHITECTURE.md` contract update.
- [ ] `src/lib/meshRelay.ts` strict ingress adjustment.
- [ ] `src/hooks/useObservatoryData.ts` source contract confirmation if needed.
- [ ] `server/routes/reports.ts` atomic idempotency route.
- [ ] `server/db.ts` transaction helper or persistence support.
- [ ] schema/migration files only if required and separately reviewed.
- [ ] focused relay tests.
- [ ] focused API/server tests.
- [ ] integration/concurrency test.

## A1 implementation prohibitions

- [x] no silent fallback to content tuple deduplication.
- [x] no silent permanent local mapping as a substitute for origin identity.
- [x] no claiming local replay cache provides durable idempotency.
- [x] no changing badge or consensus behavior.
- [x] no broad refactor unrelated to origin identity.
- [x] no push in implementation review.

## A1 approval record

- Approved decision: **A1 — Strict Origin `clientGeneratedId`**.
- Approved core invariant: **atomic server idempotency keyed by `clientGeneratedId`**.
- Deferred semantics: **same ID + different body** and **Firestore unavailable**.
- Current phase: **contract review and transaction semantics**.
- Implementation status: **not started**.
- Commit status: **none for A1**.
- Push status: **not performed**.

## A1 pending review questions

- [ ] Is the idempotency record written in the same Firestore transaction as the report document?
- [ ] Does a concurrent loser read and return the winner’s original report?
- [ ] Does a retry after a committed report avoid AI, badge consumption, alerts, and broadcasts a second time?
- [ ] Is ID reuse with a different canonical request detectable without choosing its response policy?
- [ ] Is missing-ID rejection before replay reservation and queue admission?
- [ ] Does strict rejection preserve protocol compatibility expectations explicitly rather than silently?
- [ ] Are all error codes and observability fields documented?
- [ ] Are transaction retry and Firestore contention limits represented in tests?
- [ ] Are no-db paths clearly excluded from durable exactly-once claims?
- [ ] Is the new contract isolated from deferred badge and consensus decisions?

## A1 phase gate

- [ ] Phase 1 contract review.
- [ ] Phase 2 transaction semantics.
- [ ] Phase 3 implementation scope.
- [ ] Phase 4 user approval to implement.
- [ ] Phase 5 production implementation.
- [ ] Phase 6 focused regression.
- [ ] Phase 7 full validation.
- [ ] Phase 8 commit review.
- [ ] Phase 9 push approval.

## A1 status summary

The decision is approved, but the implementation contract is still under review. Production code remains untouched. The next deliverable is a concise transaction-and-scope proposal, not a patch.

## A1 approved implementation work

- [x] Capture baseline HEAD, branch, status, and allowed-file boundary before edits.
- [x] Update `ARCHITECTURE.md` with the approved A1 contract and explicit non-scope.
- [x] Reject missing-origin Mesh envelopes before replay reservation, queue, journal, and HTTP.
- [x] Remove relay-generated replacement IDs from the strict Mesh path.
- [ ] Implement durable atomic report + idempotency persistence for Admin and Client Firestore SDK paths.
- [ ] Preserve deferred Same ID + different body classification without inventing response semantics.
- [ ] Preserve deferred Firestore-unavailable semantics without claiming durable exactly-once.
- [x] Add regressions for origin propagation, missing-ID rejection, concurrent first writes, reload/restart retry, and same-ID body mismatch detection.
- [ ] Run focused validation and record failures/unavailable checks.
- [ ] Re-audit changed code and prepare requested diff/stat/status/SHA artifacts.
- [ ] Do not create commit or push during this implementation phase.
- [ ] Stop if Firestore SDK cannot provide the required atomicity without an unapproved architectural change.

## A1 user-approved gates

- [x] Local implementation approved.
- [x] Scope limited to `ARCHITECTURE.md`, relay/server files, and necessary tests.
- [x] No commit approved yet.
- [x] No push approved yet.
- [x] Diff review completed; clean per-file artifacts prepared.
- [ ] Re-audit completed.
- [ ] Commit decision pending.
- [ ] Push decision pending.

## A1 requested final artifacts

- [x] `git diff --stat`.
- [x] Diff for `ARCHITECTURE.md`.
- [x] Diff for `src/lib/meshRelay.ts`.
- [x] Diff for `server/db.ts`.
- [x] Diff for `server/routes/reports.ts`.
- [x] All modified test-file diffs.
- [ ] Complete acceptance matrix.
- [ ] New findings discovered during implementation.
- [x] `git status`.
- [x] Current SHA before any commit.
- [x] Explicit confirmation that no commit or push occurred.

## A1 current blocker policy

- [ ] If atomicity requires a new Firestore schema/migration outside the approved file boundary, stop and report blocker before implementation.
- [ ] If Admin and Client SDK transactions diverge in semantics, stop and report required contract choice.
- [ ] If exact Same ID + different body response behavior is required to implement atomicity, stop and request a separate policy decision.
- [ ] If tests cannot run because dependencies/build tooling are unavailable, report exact reason and do not claim validation.

## A1 implementation trace

- [x] Baseline captured.
- [x] Architecture contract updated.
- [x] Relay boundary updated.
- [x] Server transaction path updated — helper and route integration use atomic persistence and 409 mismatch classification.
- [x] Tests updated.
- [x] Focused tests pass: 20 tests across 4 files; typecheck clean.
- [ ] Full validation pass/fail/unavailable recorded.
- [ ] Re-audit report prepared.
- [ ] User receives requested artifacts.
- [ ] No commit.
- [ ] No push.

## A1 approved mismatch semantics

- [x] اعتماد `409 IDEMPOTENCY_KEY_REUSE` لنفس origin ID مع canonical fingerprint مختلف.
- [x] تثبيت أن نفس ID ونفس fingerprint يعيدان النتيجة الأصلية دون إنشاء أو overwrite.
- [x] تثبيت أن fingerprint يحسب من canonical normalized request representation ثم SHA-256، وليس raw HTTP body.
- [x] إبقاء missing ID وFirestore unavailable semantics كما هي في A1.
- [x] توثيق قرار mismatch المستقل في `ARCHITECTURE.md`.
- [x] تنفيذ canonical request normalization/fingerprint في المسار الخادمي.
- [x] ربط atomic idempotency helper بالroute وإرجاع 409 عند mismatch.
- [x] إضافة اختبارات نفس ID/نفس fingerprint، نفس ID/different fingerprint، والتزامن.
- [ ] تشغيل focused/full validation حسب ما تسمح به البيئة.
- [ ] عرض diff وacceptance matrix قبل commit.
- [ ] لا commit ولا push في هذه المرحلة.

## A1 re-audit finding: legacy durable reports

- [ ] Investigate reports already stored with `clientGeneratedId` but without a `reportIdempotency/{clientGeneratedId}` record.
- [ ] Decide whether A1 needs a one-time backfill, lazy transactionally safe backfill, or explicit legacy quarantine.
- [ ] Do not treat the current cache/limited report scan as durable idempotency for legacy records.
- [ ] Add a regression for a pre-A1 durable report and a retry after server restart.
- [ ] Pause final acceptance and commit decision until legacy handling is explicitly scoped.

## A1 approved L1 legacy backfill

- [x] اعتماد L1 Lazy Transactional Backfill من المستخدم.
- [x] تحقق من Firestore SDK الفعلي: Admin `Transaction.get(Query)` يدعم query داخل transaction مع read-set/retry semantics؛ Client Web `Transaction` المثبت يعرّف `get(DocumentReference)` فقط ولا يدعم query داخل transaction.
- [x] توثيق نتيجة semantics قبل implementation؛ query ثم create خارج Client transaction لا يحقق العقد.
- [x] تنفيذ legacy lookup داخل Admin transaction فقط؛ Client SDK لا يوفر transaction query API ولا يدخل هذا المسار.
- [x] exactly one legacy match: bind idempotency key إلى التقرير وإعادة النتيجة.
- [x] more than one legacy match: integrity failure صريح، بلا report جديد وبلا idempotency record.
- [x] zero legacy matches: إنشاء report + idempotency record داخل transaction نفسها.
- [x] legacy same ID + different fingerprint: `409 IDEMPOTENCY_KEY_REUSE`.
- [x] concurrent legacy retries: لا duplicate.
- [ ] transaction crash/retry: لا orphan key ولا report ثالث.
- [x] إضافة regression matrix الكاملة لحالات L1 قبل الإغلاق؛ focused transaction suite الآن 6 tests.
- [x] لا lock ولا cache ولا limited scan كحل لـlegacy source of truth.
- [x] لا commit ولا push.

## A1 Admin-only L1 approval

- [x] اعتماد Admin-only durable path من المستخدم.
- [x] منع Client SDK من ادعاء دعم L1 أو استخدام query خارج transaction كبديل.
- [x] توثيق `ARCHITECTURE.md` بعقد Admin-only وfailure صريح لمسار Client.
- [x] تنفيذ legacy query داخل Admin transaction read-set.
- [x] exactly-one legacy match: bind idempotency key وإعادة report القديم.
- [x] zero legacy matches: إنشاء report وidempotency key في transaction نفسها.
- [x] multiple legacy matches: integrity failure بلا أي write.
- [ ] concurrent legacy retries: transaction retry/no duplicate.
- [x] legacy body mismatch: 409 دون overwrite.
- [x] Client/no-Admin path: failure صريح لا يدعي durable idempotency.
- [ ] crash/commit boundary regressions.
- [ ] full validation وre-audit قبل عرض diff.
- [x] لا commit ولا push.

## A1 re-audit finding: pre-A1 queued items

- [x] Investigate persisted pending queue items that lack `clientGeneratedId` after strict ingress is enabled.
- [x] Do not silently skip such items forever in `flushQueueInternal()`; Q1 now routes them through the existing DLQ commit pipeline.
- [x] Decide explicit handling for pre-A1 queued items: Q1 observable quarantine in the existing DLQ.
- [x] Add regression for reload containing a legacy pending item.
- [x] Keep final acceptance and commit blocked until this policy is explicit.

## A1 approved Q1 legacy pending quarantine

- [x] اعتماد Q1 — Quarantine/DLQ observable من المستخدم.
- [x] تثبيت السبب الدقيق `missing_origin_client_generated_id`.
- [x] عدم توليد أو استعادة origin ID لعناصر legacy.
- [x] توثيق Q1 في `ARCHITECTURE.md` دون تغيير DLQ lifecycle أو retention policy.
- [x] إزالة legacy pending item غير الصالح من pending عند flush.
- [x] نقله إلى DLQ الحالي بنفس السبب فقط.
- [x] ضمان عدم HTTP أو journal preparation أو retry جديد.
- [x] تسجيل الحدث observable.
- [x] عند فشل DLQ، الحفاظ على semantics الحالية وعدم silent discard؛ العنصر يبقى محفوظًا pending/volatile وفق المسار الحالي.
- [x] إضافة regressions لكل حالات Q1 وlegacy صالح وinvalid ID وreload.
- [x] إضافة regression لـDLQ unavailable.
- [x] إعادة تشغيل full validation وإعادة تدقيق A1: Vitest/lint/build نجحت؛ E2E سجل 17/18 بسبب report-flow مع `SKIP_FIREBASE=true` وAdmin-only durable path.
- [x] لا commit ولا push.

## A1 E2E report-flow diagnosis

- [ ] إضافة instrumentation مؤقت لتسجيل استجابة `POST /api/reports` داخل `report-flow.spec.ts`.
- [ ] تشغيل `report-flow` على منفذ معزول مع `SKIP_FIREBASE=true` وتسجيل status/body الفعليين.
- [ ] حذف instrumentation المؤقت بعد التشخيص وعدم تغيير invariant الإنتاج.
- [ ] تصنيف سبب الفشل المثبت وتحديد ما إذا كانت بيئة E2E تحتاج Admin Firestore emulator/fixture.
- [ ] لا commit ولا push أثناء التشخيص.

## A1 E2E report-flow diagnosis

- [x] إضافة instrumentation مؤقت لتسجيل استجابة `POST /api/reports` داخل `report-flow.spec.ts`.
- [x] تشغيل `report-flow` على منفذ معزول مع `SKIP_FIREBASE=true` وتسجيل status/body الفعليين: `503 DURABLE_IDEMPOTENCY_UNAVAILABLE`.
- [x] حذف instrumentation وconfig المؤقتين بعد التشخيص وعدم تغيير invariant الإنتاج.
- [x] تصنيف السبب المثبت: بيئة E2E تحتاج Admin Firestore emulator/fixture لمسار report-flow، وليست مشكلة selector أو transaction implementation.
- [x] لا commit ولا push أثناء التشخيص.

## A1 durable E2E provisioning design

- [x] فحص توفر Firebase Emulator وJava وCLI في بيئة المشروع.
- [x] مراجعة `package.json` و`playwright.config.ts` و`server/firebase.ts` وbootstrap الخادم.
- [x] تحديد minimal emulator/fixture lifecycle الذي يشغل Admin SDK دون `SKIP_FIREBASE`.
- [x] تحديد health assertion يثبت أن E2E تعمل عبر Admin durable path قبل `report-flow`.
- [x] عرض نطاق الملفات والتغييرات المقترحة قبل التنفيذ في `a1-e2e-emulator-design.md`.
- [ ] لا تعديل production idempotency ولا memory fallback.
- [ ] لا commit ولا push.

## A1 approved durable E2E implementation

- [x] تنفيذ محلي محدود لـFirestore Emulator fixture مع Admin durable path تمت الموافقة عليه.
- [x] التحقق من baseline وملفات النطاق قبل التعديل.
- [x] إضافة `firebase-tools` و`firebase.json` لإعداد Firestore Emulator فقط.
- [x] تعديل `server/firebase.ts` بصورة مشروطة بـ`FIRESTORE_EMULATOR_HOST` فقط.
- [ ] إضافة health assertion تثبت `admin` durable path داخل E2E.
- [ ] تنظيف Firestore Emulator قبل report-flow وإثبات project ID والـhost.
- [ ] تشغيل report-flow وإظهار دليل يثبت Admin durable path.
- [ ] إيقاف التنفيذ إذا تغيّر سلوك production دون emulator.
- [ ] لا تعديل `server/db.ts` أو `server/routes/reports.ts` أو A1 semantics أو memory fallback.
- [ ] لا commit ولا push.

## A1 Firestore Emulator finding: undefined report fields

- [x] إثبات أن Admin Firestore transaction تصل فعليًا إلى Emulator قبل الفشل.
- [x] إثبات أن سبب 503 ليس fixture أو bootstrap: `tx.create(report)` يرفض `image: undefined`.
- [ ] اختيار سياسة تطبيع حقول report الاختيارية قبل الكتابة إلى Firestore.
- [ ] عدم تمكين `ignoreUndefinedProperties` عالميًا دون قرار صريح.
- [ ] إضافة regression واقعي لـAdmin Firestore/Emulator بعد اعتماد السياسة.
- [ ] إيقاف E2E durable green claim حتى معالجة finding.
- [ ] إزالة instrumentation المؤقت وعدم commit أو push.

## A1 approved S1 persistence normalization

- [x] اعتماد S1: إزالة undefined من نسخة persistence فقط قبل `tx.create`.
- [x] إضافة `removeUndefinedDeepForFirestore` محصورة في `server/db.ts` ولا تعدّل report الأصلي.
- [x] الحفاظ على canonical fingerprint وclientGeneratedId وAPI response كما هي.
- [x] عدم إضافة `ignoreUndefinedProperties` أو تغيير `server/routes/reports.ts` أو memory fallback.
- [x] إضافة Emulator regression لبلاغ بلا `image` يتحقق من report وidempotency key معًا.
- [x] التحقق من عدم وجود undefined في الوثيقة المخزنة.
- [x] إثبات عدم تغيّر fingerprint قبل/بعد persistence normalization.
- [x] تشغيل 339 اختبارًا وreport-flow عبر Admin Emulator.
- [x] التوقف لمراجعة أي undefined إضافي قبل توسيع sanitizer؛ لم يظهر undefined آخر في التشغيل الحالي.
- [x] لا commit ولا push.

## E2E Emulator finding: consensus cache invalidation

- [x] إثبات أن report persistence وواجهة النجاح يمران عبر Admin Emulator بعد S1.
- [x] إثبات أن confirmation transaction تحدّث Firestore لكن `GET /api/reports` يقرأ cache قديمًا خلال 30 ثانية.
- [ ] تحديد سياسة invalidation بعد `confirmReportInFirestore` دون خلطها مع A1 idempotency.
- [ ] إضافة regression يجعل confirmation مرئيًا في القراءة اللاحقة فورًا.
- [ ] عدم تغيير A1 أو memory fallback أو commit/push قبل قرار صريح.

## Approved consensus cache consistency repair

- [x] اعتماد invalidation بعد نجاح `confirmReportInFirestore()` transaction فقط.
- [x] استدعاء `invalidateReportsCache()` بعد عودة transaction الناجحة وليس داخل callback.
- [x] إضافة regression: confirmation ناجح ثم `GET /api/reports` يرى consensus الجديد دون انتظار TTL.
- [x] إثبات أن فشل transaction لا يبطل cache قبل commit by placing invalidation after `runTransaction()` resolves.
- [x] تشغيل suite الحالية وE2E Emulator الكامل: 44 files / 339 tests و18/18 E2E.
- [x] لا تعديل TTL أو A1 أو idempotency أو fallback أو DLQ.
- [x] لا commit ولا push.

## User-requested diff code review package

- [x] استخراج diff كامل لـS1 في `server/db.ts`.
- [x] استخراج diff كامل لموضع `confirmReportInFirestore()` و`invalidateReportsCache()`.
- [x] استخراج diff لتهيئة Emulator وAdmin bootstrap وhealth assertion.
- [x] استخراج diff لكل tests جديدة أو معدلة، بما فيها `report-flow.spec.ts`.
- [x] تقسيم النصوص الكبيرة إلى أجزاء قابلة للنسخ دون إسقاط أسطر.
- [x] عرض الـdiff للمراجعة؛ موافقة المستخدم على commit محلي لاحقة.

## Approved baseline commit

- [x] المستخدم وافق على commit محلي للدفعة المستقرة فقط.
- [x] تشغيل `git status` و`git diff --check` و`git diff --stat` قبل staging.
- [x] مراجعة أن الملفات توافق نطاق A1/S1/Emulator/cache regression فقط.
- [ ] إضافة الدفعة وإنشاء commit بالرسالة المعتمدة.
- [ ] عرض `git status` و`git log -1 --oneline` بعد commit.
- [ ] عدم تنفيذ push؛ يلزم قرار منفصل.

## Approved baseline push

- [x] المستخدم وافق صراحة على دفع commit `1fcc4c1`.
- [ ] التحقق من remote واسم الفرع المستهدف قبل الدفع.
- [ ] دفع commit `1fcc4c1` فقط إلى `origin/audit/fix-remaining-findings`.
- [ ] التحقق من SHA المنشور عبر remote بعد نجاح الدفع.

## Findings imported from attached audit report

- [ ] تحقق من workflow CI وإزالة `SKIP_FIREBASE=true` من job الخاص بـE2E إذا كان موجودًا.
- [ ] توحيد package manager في CI مع `pnpm-lock.yaml` باستخدام تثبيت frozen lockfile.
- [ ] تشغيل اختبارات CI-like بعد إصلاح workflow، مع فصل ما يمكن التحقق منه محليًا عما يحتاج GitHub Actions.
- [ ] تصنيف asymmetry لمسار Client SDK في `confirmReportInFirestore()` قبل أي إصلاح.
- [ ] إبقاء badge `maxUses` على audit board وعدم تعديلها قبل قرار معماري مستقل.
- [ ] إبقاء Mesh identity/cryptography/any-to-any relay وdistributed dedup على audit board.
- [ ] مزامنة هذا السجل مع HEAD وremote HEAD والـfindings المغلقة والمفتوحة بعد انتهاء إصلاحات CI.
- [ ] تنفيذ UX/UI audit للرحلات الحرجة: البلاغ، SOS، الخريطة، offline، accessibility/mobile.
- [ ] عدم اعتبار المشروع release-ready قبل إغلاق بوابات CI وUX والـsystem-wide audit اللاحقة.
- [ ] لا push إضافي قبل مراجعة المستخدم للـdiff والـvalidation الخاص بهذه الدفعة.

## CI repair gate

- [ ] لا تعديل على Badge أو Mesh أو Client confirmation semantics قبل تصنيفها وعرض القرار.
- [ ] لا commit لإصلاحات CI قبل مراجعة نطاق الملفات ونتائج الاختبارات.
- [ ] لا push لإصلاحات CI قبل موافقة صريحة منفصلة.

## Audit ledger reconciliation gate

- [ ] تحديث current local HEAD وremote HEAD.
- [ ] تحديث حالات A1/S1/cache/E2E وCI findings.
- [ ] توثيق findings المفتوحة والقرارات المؤجلة وخطواتها التالية.

## Current execution order — CI then UX/UI audit

- [x] عدم تعديل Badge أو Mesh أو أي finding جديد أثناء هذه المرحلة.
- [x] التحقق من CI: إزالة `SKIP_FIREBASE=true` واعتماد pnpm في workflow فقط.
- [x] تشغيل lint/typecheck.
- [x] تشغيل unit/integration tests.
- [x] تشغيل production build.
- [x] تشغيل E2E عبر Firestore Emulator.
- [x] عدم إنشاء commit قبل اكتمال validation ونجاح جميع البوابات.
- [x] اختبار التطبيق يدويًا على شاشة هاتف وفق الرحلات العشر المحددة.
- [x] تسجيل UX findings والأدلة فقط دون اقتراح أو تنفيذ حلول.
- [ ] إرسال نتيجة CI وUX/UI للمستخدم قبل أي تعديل لاحق.

## Merged text deliverable

- [ ] دمج `wildfire-ux-audit-report.md` و`wildfire-ux-audit-notes.md` وسجل console في ملف نصي واحد.
- [ ] وضع اسم كل ملف وفواصل واضحة مع الحفاظ على المحتوى كاملًا.
- [ ] تسليم الملف المدمج كنص قابل للنسخ دون commit أو push.

## Round 2 failure-state audit from attached report

- [ ] مقارنة UX-001 إلى UX-008 مع الأدلة الحالية وتصنيفها Confirmed/Candidate/Unverified.
- [x] اختبار الشبكة البطيئة والانقطاع الكامل وعودة الشبكة والخادم غير المتاح.
- [x] اختبار GPS مرفوض وGPS timeout وGPS متاح بلا ولاية مؤكدة.
- [x] اختبار الإرسال البطيء وفشل الإرسال بعد الضغط.
- [x] اختبار SOS مع GPS وبدون GPS.
- [x] اختبار رفض الصورة/الكاميرا وrefresh أثناء draft وإغلاق الهاتف أثناء المزامنة والعودة بعد فترة.
- [x] لكل حالة تسجيل: ماذا حدث، هل البلاغ محفوظ، وما الإجراء التالي الظاهر خلال ثانيتين.
- [x] عدم تعديل UX code أو إضافة features قبل تصنيف الأدلة وعرضها.
- [x] تطبيق الإصلاحات فقط بعد قرار صريح على findings المؤكدة.

## Approved UX fixes to implement after verification

- [x] توحيد حالة الاتصال في ReportForm باستخدام SyncState المشترك مع HeaderBar.
- [x] تحويل اقتراح الولاية المطابق للإحداثيات إلى قيمة نموذج معتمدة تلقائيًا مع توضيح ذلك للمستخدم.
- [x] استبدال رسائل backend التقنية برسالة عربية/فرنسية مفهومة مع إبقاء التفاصيل في console فقط.
- [x] إضافة مسار طوارئ مباشر داخل SOS عند فشل GPS، باستخدام أرقام الطوارئ الرسمية الحالية فقط.
- [x] إضافة regression tests للسلوكيات الثلاثة السابقة قبل اعتبارها مكتملة.
- [x] عدم تغيير Badge أو Mesh أو Journal أو API semantics ضمن هذه الدفعة.

## Approved UX/CI commit and push

- [ ] إعادة قراءة إرشادات Git audit وKarpathy قبل staging.
- [ ] التحقق من نطاق الملفات الحالية وعدم إدراج أدلة أو ملفات مؤقتة.
- [ ] تشغيل diff check وvalidation النهائي أو الاعتماد على النتائج الأخيرة مع إعادة فحص الحالة.
- [ ] إنشاء commit للدفعة الحالية برسالة واضحة.
- [ ] دفع commit إلى `origin/audit/fix-remaining-findings`.
- [ ] التحقق من SHA المنشور وعرض الملفات والحالة النهائية.

## Findings from post-push audit report

- [x] F-001: توسيع GitHub Actions ليغطي فرع التدقيق؛ check run فعلي ينتظر commit/push جديد.
- [x] F-002: اعتماد mapping مغلق لرسائل أخطاء التقارير ومنع عرض تفاصيل backend غير المعروفة.
- [x] F-003: جعل نجاح SOS وprofile persistence مشروطًا بالتخزين الدائم ومعالجة duplicate فقط بعد النجاح.
- [x] F-004: مقارنة الولاية المحددة بالولاية المحلولة كاملةً، لا باسم الدولة فقط.
- [x] F-005: التحقق من الرقم 14 وإضافته كخيار طوارئ مباشر إلى جانب 1021 و1070.
- [x] F-006: تشغيل محاولة مزامنة المسودات عند `mesh:online` مع احتفاظ الطابور بالمسودة عند الفشل.
- [x] F-007: استبدال مفتاح replay ذي 32-bit ببصمة SHA-256 مع الحفاظ على توافق queue/journal القديم.
- [x] F-008: توثيق SOS profile/device binding كحد privacy/auth معماري؛ لا يدّعي مصادقة حقيقية.
- [ ] لا commit أو push قبل التحقق الكامل وعرض diff ونتائج validation.

## Approved F-001 to F-008 commit and push

- [x] المستخدم وافق صراحة على إنشاء commit ودفع الدفعة الحالية.
- [ ] مراجعة قائمة الملفات و`git diff --check` قبل staging.
- [ ] إنشاء commit محدود للإصلاحات المتحققة.
- [ ] دفع commit إلى `origin/audit/fix-remaining-findings`.
- [ ] التحقق من SHA المنشور وحالة working tree.

## GitHub Actions build-approval follow-up

- [ ] تحديد packages التي يمنع pnpm 11 build scripts الخاصة بها في GitHub Actions.
- [ ] إضافة allowBuilds صريحة بالحد الأدنى في إعداد مشروع pnpm.
- [ ] التحقق من `pnpm install --frozen-lockfile` في CI-like local environment.
- [ ] إنشاء ودفع commit تصحيحي لمشكلة CI بعد validation.
- [ ] مراقبة workflow الجديد وتسجيل النتيجة الفعلية على GitHub.
