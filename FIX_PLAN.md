# Wildfire Observatory fix plan

## Phase 0 baseline

Verified clean main at `caa58fb4a103f0d03c67e1506c4c288419a1b724` (`fix(audit): address review findings (#123)`). Node v24.22.1 and npm 10.9.4.

- `corepack pnpm install` exited 127 with `corepack: command not found`.
- `npm install --no-package-lock` exited 1 with `Cannot read properties of null (reading 'edgesOut')` in npm Arborist's peer resolver.
- `npm install --no-package-lock --legacy-peer-deps --no-audit --no-fund --cache /tmp/wildfire-npm-cache` filled the 512 MiB temporary filesystem during dependency resolution. The task cache was moved onto the work clone disk.
- Retried with `npm install --no-package-lock --legacy-peer-deps --no-audit --no-fund --cache "$PWD/.npm-cache"`.


The final install succeeded with 1,359 packages. npm reported deprecations for node-domexception 1.0.0, uuid 9.0.1, json-ptr 3.1.1, and glob 10.5.0 and 11.1.0. Versions used were TypeScript 5.8.3, Vitest 4.1.12, Vite 8.3.8 and vite-plugin-pwa 1.3.0.

The first lint run returned 10 TS2305 diagnostics in five React test files. The server half of `npm test` passed. All 73 React files in the React half stopped at setup because npm legacy peer resolution omitted `@testing-library/dom`. That was one dependency setup failure, with zero React tests collected. The production client and server build passed and Vite warned about future native config loading and the existing `__dirname` usage.

Recovered the peer with `npm install --prefix "$PWD/.npm-cache/test-peer" --no-package-lock --no-audit --no-fund --cache "$PWD/.npm-cache" @testing-library/dom@10.4.1` and linked it under `node_modules/@testing-library`. Both the lint and React baseline were rerun from a pristine archive of main inside the clone, using the same dependency tree.

| Baseline check | Result |
| --- | --- |
| Lint after peer recovery | Pass, 0 diagnostics |
| Server Vitest | 67 passed test files, 654 passed tests |
| React Vitest after peer recovery | 73 passed test files, 764 passed tests |
| Build | Pass, client and server bundles generated |

No pre-existing test failures remained after peer recovery.

## Planned fixes

| Part | Findings | Scope |
| --- | ---: | --- |
| Fix 1 | 2 | Mesh frame validation and service worker API cache removal |
| Fix 2 | 3 | Protect SOS contact, location and profile data |
| Fix 3 | 3 | Bind device enrollment and responder updates to verified identities |
| Fix 4 | 4 | Enforce staff session revocation and account permissions |
| Fix 5 | 2 | Restrict production assets and scrub telemetry |
| Fix 6 | 2 | Protect operator exports and verify reporter authority |
| Fix 7 | 1 | Enforce inbound mesh peer admission |
| Fix 8 | 2 | Scope alert notifications and reporting access |
| Fix 9 | 2 | Keep durable audit and report migrations consistent |
| Fix 10 | 2 | Invalidate server document and collection caches |
| Fix 11 | 2 | Keep unit lifecycle and staff bootstrap consistent |
| Fix 12 | 4 | Distinguish dataset outages from current observations |
| Fix 13 | 2 | Keep emergency intake and resolution available |
| Fix 14 | 4 | Serialize team membership, mission and tracking updates |
| Fix 15 | 1 | Preserve roster state during read outages |
| Fix 16 | 2 | Correct native mesh delivery and SOS encoding |
| Fix 17 | 4 | Preserve native snapshots across failed, empty and oversized refreshes |
| Fix 18 | 2 | Make native emergency queues durable before confirming submission |
| Fix 19 | 3 | Handle native camera lifecycle and image limits |
| Fix 20 | 4 | Require fresh native coordinates at capture, route, report and SOS time |
| Fix 21 | 3 | Correct native heading, dashboard weather and location freshness |
| Fix 22 | 2 | Correct native route clearance and scope guidance to location |
| Fix 23 | 2 | Require one native SOS countdown and distinct arrival fixes |
| Fix 24 | 4 | Keep command, team and roster views consistent through overlapping requests |
| Fix 25 | 4 | Correct web radar inputs and evacuation guidance |
| Fix 26 | 2 | Refresh evacuation centres and restore management visibility |
| Fix 27 | 3 | Keep web SOS recording and microphone lifecycle consistent |
| Fix 28 | 3 | Preserve web report drafts and release camera streams |
| Fix 29 | 3 | Restore web feed polling, session state and volunteer validation |
| Fix 30 | 5 | General web controls and accessibility (AI, HDR, DLG, TST) |
| Fix 31 | 2 | General web controls and accessibility (GDE) |
| Fix 32 | 5 | Administration and command UI (ADM, CMD, AUD) |
| Fix 33 | 5 | Administration and command UI (BDG, STF, CLK, CMAP) |
| Fix 34 | 3 | Administration and command UI (RPT, SPN, CSTAT) |
| Fix 35 | 5 | Web radar, emergency display and mapping (RAD, MAP, STA) |
| Fix 36 | 5 | Web radar, emergency display and mapping (STA, EVAC, PROX, GEO) |
| Fix 37 | 5 | Web roster, team, SOS and session state (RSTR, TEAM, SOSM, SES) |
| Fix 38 | 4 | Web roster, team, SOS and session state (API, TEAM) |
| Fix 39 | 5 | Web report and registration inputs (FRM, VOL, UPL, RSUB) |
| Fix 40 | 3 | Web report and registration inputs (DRAFT, RCAM, RIMG) |
| Fix 41 | 5 | Server routes and request handling (SRV, ADM, AUD, CMD, NTF) |
| Fix 42 | 5 | Server routes and request handling (RPT, RSTR, SAT) |
| Fix 43 | 5 | Server routes and request handling (SOS, TEAM, USR, VOL) |
| Fix 44 | 5 | Server storage, device bindings and documentation (DB, DVC, MAIL, FS) |
| Fix 45 | 2 | Server storage, device bindings and documentation (SWAG, TRG) |
| Fix 46 | 3 | Web mesh relay and native bridge (MREL, MBR) |
| Fix 47 | 5 | Worker, scripts and web build configuration (FPROXY, DRULES, SHOT) |
| Fix 48 | 4 | Worker, scripts and web build configuration (NHTMLCONT, NLOCK, NVITE) |
| Fix 49 | 5 | Native data, payloads and offline queue (APAY, NREP, NMODEL) |
| Fix 50 | 2 | Native data, payloads and offline queue (NMODEL, NOFF) |
| Fix 51 | 4 | Native camera and photo handling (NCAM, NPHOTO, NREPORT) |
| Fix 52 | 5 | Native location, mapping and proximity (NLOC, NLOGL) |
| Fix 53 | 5 | Native location, mapping and proximity (NMAP, NOBS) |
| Fix 54 | 1 | Native location, mapping and proximity (NPROX) |
| Fix 55 | 5 | Native mesh protocol and cryptography (NCRYPTO, NIN, NSVC) |
| Fix 56 | 1 | Native mesh protocol and cryptography (NWIRE) |
| Fix 57 | 5 | Native navigation, team UI and resources (NACT, NTEAM, NRESBG, NRESIC) |
| Fix 58 | 4 | Native navigation, team UI and resources (NRESLAY, NRESLAUNCH, NSTR) |
| Fix 59 | 5 | Android location, heading and risk tests (GeoMathTest.kt, HeadingLogicTest.kt, LocationLogicTest.kt, LocationTierTest.kt, ProximityLogicTest.kt) |
| Fix 60 | 4 | Android location, heading and risk tests (RadarV2Test.kt, RiskScoreTest.kt, WilayasTest.kt) |
| Fix 61 | 5 | Android mesh identity, admission and delivery tests (IdentityKeyPolicyTest.kt, MeshDeliveryRetryTest.kt, MeshInboundTest.kt, MeshPeerRegistryTest.kt, MeshQueueTest.kt) |
| Fix 62 | 5 | Android mesh identity, admission and delivery tests (MeshQueueTest.kt, MeshReputationTest.kt, MeshWireTest.kt) |
| Fix 63 | 1 | Android mesh identity, admission and delivery tests (MeshWireTest.kt) |
| Fix 64 | 4 | Android API target, offline queue and photo tests (ObservatoryApiTargetTest.kt, OfflineQueueTest.kt, PhotoPipelineTest.kt) |
| Fix 65 | 5 | Server session, privacy and report security tests (admin-revocation.test.ts, auth.test.ts, badges.test.ts, device-identity.test.ts, privacy-split.test.ts) |
| Fix 66 | 3 | Server session, privacy and report security tests (privacy-split.test.ts, reports-security.test.ts) |
| Fix 67 | 5 | Server AI, dataset and network resilience tests (ai-failures.test.ts, ai.test.ts, client-threats.test.ts, dataset-health.test.ts) |
| Fix 68 | 5 | Server AI, dataset and network resilience tests (dataset-validators.test.ts, fetch-retry.test.ts, geo-reverse.test.ts, history.test.ts, live.test.ts) |
| Fix 69 | 5 | Server persistence and transaction tests (atomic-lifecycle.test.ts, atomicity.test.ts, audit-durability.test.ts, firestore-boundary.test.ts) |
| Fix 70 | 2 | Server persistence and transaction tests (reports-consensus-cache.test.ts, reports-idempotency.transaction.test.ts) |
| Fix 71 | 5 | Mesh relay and socket lifecycle tests (mesh-relay.capacity-reload.test.ts, mesh-relay.f013-race.test.ts, mesh-relay.test.ts, mesh.test.ts) |
| Fix 72 | 1 | Mesh relay and socket lifecycle tests (reconnecting-socket.test.ts) |
| Fix 73 | 5 | API operations and configuration tests (config-validation.test.ts, geo.test.ts, notifications.test.ts, roster.test.ts, safezones.test.ts) |
| Fix 74 | 5 | API operations and configuration tests (sos.test.ts, team-registry.test.ts, teams-join.test.ts, teams-operations.test.ts, wilayas.test.ts) |
| Fix 75 | 5 | React operator and team view tests (components/admin-panel.test.tsx, components/registered-teams.test.tsx) |
| Fix 76 | 3 | React operator and team view tests (components/team-panel.test.tsx) |
| Fix 77 | 5 | React polling, reporting and alert lifecycle tests (observatory-hooks.test.tsx, proximity-alerts.lifecycle.test.ts, report-form-hooks.test.tsx) |
| Fix 78 | 2 | React polling, reporting and alert lifecycle tests (report-form-hooks.test.tsx) |
| Fix 79 | 4 | Playwright smoke and emergency delivery tests (smoke.spec.ts, sos.spec.ts) |

## Triage

The report line distinguishes the two minor findings with ID NTESTGEO-1.

| ID | Severity | File or area | Part | Report line |
| --- | --- | --- | --- | ---: |
| MSH-1 | Critical | server/mesh.ts | Fix 1 | 734 |
| NVITE-1 | Major | Configuration: vite.config.ts | Fix 1 | 2931 |
| SOS-1 | Major | server/routes/sos.ts | Fix 2 | 617 |
| SOS-2 | Major | server/routes/sos.ts | Fix 2 | 618 |
| SOS-3 | Major | server/routes/sos.ts | Fix 2 | 619 |
| CMD-4 | Major | server/routes/command.ts | Fix 3 | 562 |
| CMD-5 | Major | server/routes/command.ts | Fix 3 | 563 |
| NTF-1 | Major | server/routes/notifications.ts | Fix 3 | 582 |
| SAUTH-1 | Major | server/routes/auth.ts | Fix 4 | 538 |
| MWARE-1 | Major | server/middleware.ts | Fix 4 | 740 |
| USR-1 | Major | server/routes/users.ts | Fix 4 | 641 |
| SEED-2 | Major | scripts/seed-staff.ts | Fix 4 | 1322 |
| SRV-1 | Major | server/server.ts | Fix 5 | 525 |
| SENTRY-1 | Major | server/sentry-scrub.ts | Fix 5 | 758 |
| ADM-1 | Major | src/components/AdminPanel.tsx | Fix 6 | 83 |
| MAP-1 | Major | src/components/InteractiveMap.tsx | Fix 6 | 111 |
| NSVC-2 | Major | android/app/src/main/java/com/observatory/wildfire/MeshService.kt | Fix 7 | 1501 |
| MAIL-1 | Major | server/email.ts | Fix 8 | 698 |
| ADM-2 | Major | src/components/AdminPanel.tsx | Fix 8 | 84 |
| AUD-2 | Major | server/routes/audit.ts | Fix 9 | 551 |
| DB-1 | Major | server/db.ts | Fix 9 | 685 |
| ATM-2 | Major | server/atomic.ts | Fix 10 | 659 |
| FS-1 | Major | server/fs.ts | Fix 10 | 710 |
| ATM-1 | Major | server/atomic.ts | Fix 11 | 658 |
| SEED-1 | Major | scripts/seed-staff.ts | Fix 11 | 1321 |
| AIG-1 | Major | server/routes/ai.ts | Fix 12 | 544 |
| AIG-2 | Major | server/routes/ai.ts | Fix 12 | 545 |
| SZM-2 | Major | server/routes/safezones.ts | Fix 12 | 604 |
| SAT-1 | Major | server/routes/satellite.ts | Fix 12 | 610 |
| SOS-4 | Major | server/routes/sos.ts | Fix 13 | 620 |
| FS-2 | Major | server/fs.ts | Fix 13 | 711 |
| TEAM-3 | Major | server/routes/teams.ts | Fix 14 | 628 |
| TEAM-4 | Major | server/routes/teams.ts | Fix 14 | 629 |
| TEAM-5 | Major | server/routes/teams.ts | Fix 14 | 630 |
| TRG-1 | Major | server/teamRegistry.ts | Fix 14 | 774 |
| RSTR-5 | Major | server/routes/roster.ts | Fix 15 | 596 |
| NSVC-1 | Major | android/app/src/main/java/com/observatory/wildfire/MeshService.kt | Fix 16 | 1500 |
| NSVC-5 | Major | android/app/src/main/java/com/observatory/wildfire/MeshService.kt | Fix 16 | 1505 |
| NREP-1 | Major | android/app/src/main/java/com/observatory/wildfire/AppRepository.kt | Fix 17 | 1352 |
| NREP-2 | Major | android/app/src/main/java/com/observatory/wildfire/AppRepository.kt | Fix 17 | 1353 |
| NREP-3 | Major | android/app/src/main/java/com/observatory/wildfire/AppRepository.kt | Fix 17 | 1354 |
| NAPI-1 | Major | android/app/src/main/java/com/observatory/wildfire/ObservatoryApi.kt | Fix 17 | 1543 |
| NREP-4 | Major | android/app/src/main/java/com/observatory/wildfire/AppRepository.kt | Fix 18 | 1355 |
| NREP-5 | Major | android/app/src/main/java/com/observatory/wildfire/AppRepository.kt | Fix 18 | 1356 |
| NCAM-1 | Major | android/app/src/main/java/com/observatory/wildfire/CameraCaptureFragment.kt | Fix 19 | 1367 |
| NCAM-2 | Major | android/app/src/main/java/com/observatory/wildfire/CameraCaptureFragment.kt | Fix 19 | 1368 |
| NPHOTO-1 | Major | android/app/src/main/java/com/observatory/wildfire/PhotoPipeline.kt | Fix 19 | 1580 |
| NCAM-3 | Major | android/app/src/main/java/com/observatory/wildfire/CameraCaptureFragment.kt | Fix 20 | 1369 |
| NMAP-3 | Major | android/app/src/main/java/com/observatory/wildfire/MapFragment.kt | Fix 20 | 1451 |
| NREPORT-1 | Major | android/app/src/main/java/com/observatory/wildfire/ReportFragment.kt | Fix 20 | 1617 |
| NSOS-1 | Major | android/app/src/main/java/com/observatory/wildfire/SosFragment.kt | Fix 20 | 1632 |
| NHEAD-1 | Major | android/app/src/main/java/com/observatory/wildfire/HeadingEngine.kt | Fix 21 | 1405 |
| NOBS-1 | Major | android/app/src/main/java/com/observatory/wildfire/ObservatoryFragment.kt | Fix 21 | 1559 |
| NOBS-2 | Major | android/app/src/main/java/com/observatory/wildfire/ObservatoryFragment.kt | Fix 21 | 1560 |
| NMAP-1 | Major | android/app/src/main/java/com/observatory/wildfire/MapFragment.kt | Fix 22 | 1449 |
| NMAP-2 | Major | android/app/src/main/java/com/observatory/wildfire/MapFragment.kt | Fix 22 | 1450 |
| NSOS-2 | Major | android/app/src/main/java/com/observatory/wildfire/SosFragment.kt | Fix 23 | 1633 |
| NTEAMSV-1 | Major | android/app/src/main/java/com/observatory/wildfire/TeamLocationService.kt | Fix 23 | 1655 |
| CMD-1 | Major | src/components/CentralCommand.tsx | Fix 24 | 92 |
| TEAM-1 | Major | src/components/TeamPanel.tsx | Fix 24 | 294 |
| RSTR-1 | Major | src/components/RosterBoard.tsx | Fix 24 | 277 |
| RSTR-2 | Major | src/components/RosterBoard.tsx | Fix 24 | 278 |
| RAD-1 | Major | src/components/EvacuationRadar.tsx | Fix 25 | 100 |
| RAD-3 | Major | src/components/EvacuationRadar.tsx | Fix 25 | 126 |
| WIL-1 | Major | src/components/WilayaList.tsx | Fix 25 | 145 |
| EVAC-1 | Major | src/components/SafeEvacuation.tsx | Fix 25 | 286 |
| EVAC-2 | Major | src/components/SafeEvacuation.tsx | Fix 26 | 287 |
| SZM-1 | Major | src/components/admin/SafeZonesManager.tsx | Fix 26 | 322 |
| SOSM-1 | Major | src/components/TrappedSOSModal.tsx | Fix 27 | 301 |
| SOSM-2 | Major | src/components/TrappedSOSModal.tsx | Fix 27 | 302 |
| SOSM-3 | Major | src/components/TrappedSOSModal.tsx | Fix 27 | 303 |
| RFSH-1 | Major | src/hooks/reportForm/reportFormShared.ts | Fix 28 | 420 |
| RCAM-1 | Major | src/hooks/reportForm/useReportCamera.ts | Fix 28 | 436 |
| DRAFT-2 | Major | src/utils/offlineDraftStore.ts | Fix 28 | 1251 |
| POLL-1 | Major | src/hooks/observatory/useObservatoryPoll.ts | Fix 29 | 403 |
| AUTH-1 | Major | src/hooks/useAuth.ts | Fix 29 | 457 |
| VOL-1 | Major | src/components/VolunteerRegistration.tsx | Fix 29 | 138 |
| AI-1 | Minor | src/components/AICopilot.tsx | Fix 30 | 26 |
| AI-2 | Minor | src/components/AICopilot.tsx | Fix 30 | 27 |
| HDR-1 | Minor | src/components/layout/HeaderBar.tsx | Fix 30 | 41 |
| DLG-1 | Minor | src/components/ui/ConfirmDialog.tsx | Fix 30 | 67 |
| TST-1 | Minor | src/components/ui/ToastStack.tsx | Fix 30 | 73 |
| GDE-1 | Minor | src/components/SafetyGuides.tsx | Fix 31 | 159 |
| GDE-2 | Minor | src/components/SafetyGuides.tsx | Fix 31 | 160 |
| ADM-3 | Minor | src/components/AdminPanel.tsx | Fix 32 | 85 |
| ADM-4 | Minor | src/components/AdminPanel.tsx | Fix 32 | 86 |
| CMD-2 | Minor | src/components/CentralCommand.tsx | Fix 32 | 93 |
| CMD-3 | Minor | src/components/CentralCommand.tsx | Fix 32 | 94 |
| AUD-1 | Minor | src/components/admin/AuditLog.tsx | Fix 32 | 310 |
| BDG-1 | Minor | src/components/admin/BadgeManager.tsx | Fix 33 | 316 |
| STF-1 | Minor | src/components/admin/StaffManager.tsx | Fix 33 | 328 |
| CLK-1 | Minor | src/components/command/CommandLock.tsx | Fix 33 | 342 |
| CLK-2 | Minor | src/components/command/CommandLock.tsx | Fix 33 | 343 |
| CMAP-1 | Minor | src/components/command/CommandMap.tsx | Fix 33 | 349 |
| RPT-1 | Minor | src/components/command/ReportsTable.tsx | Fix 34 | 359 |
| SPN-1 | Minor | src/components/command/SosPanel.tsx | Fix 34 | 365 |
| CSTAT-1 | Minor | src/components/command/StatCards.tsx | Fix 34 | 371 |
| RAD-2 | Minor | src/components/EvacuationRadar.tsx | Fix 35 | 101 |
| MAP-2 | Minor | src/components/InteractiveMap.tsx | Fix 35 | 112 |
| MAP-3 | Minor | src/components/InteractiveMap.tsx | Fix 35 | 113 |
| MAP-4 | Minor | src/components/InteractiveMap.tsx | Fix 35 | 114 |
| STA-1 | Minor | src/components/StatisticsPanel.tsx | Fix 35 | 151 |
| STA-2 | Minor | src/components/StatisticsPanel.tsx | Fix 36 | 152 |
| STA-3 | Minor | src/components/StatisticsPanel.tsx | Fix 36 | 153 |
| EVAC-3 | Minor | src/components/SafeEvacuation.tsx | Fix 36 | 288 |
| PROX-1 | Minor | src/hooks/useProximityAlerts.ts | Fix 36 | 479 |
| GEO-1 | Minor | src/utils/geo.ts | Fix 36 | 1228 |
| RSTR-3 | Minor | src/components/RosterBoard.tsx | Fix 37 | 279 |
| RSTR-4 | Minor | src/components/RosterBoard.tsx | Fix 37 | 280 |
| TEAM-2 | Minor | src/components/TeamPanel.tsx | Fix 37 | 295 |
| SOSM-4 | Minor | src/components/TrappedSOSModal.tsx | Fix 37 | 304 |
| SES-1 | Minor | src/lib/session.ts | Fix 37 | 501 |
| API-1 | Minor | src/utils/api.ts | Fix 38 | 1183 |
| API-2 | Minor | src/utils/api.ts | Fix 38 | 1184 |
| TEAM-7 | Minor | src/utils/teamSession.ts (with targeted TEAM-7 verification in TeamPanel) | Fix 38 | 1259 |
| TEAM-8 | Minor | src/utils/teamSession.ts (with targeted TEAM-7 verification in TeamPanel) | Fix 38 | 1260 |
| FRM-1 | Minor | src/components/ReportForm.tsx | Fix 39 | 132 |
| VOL-2 | Minor | src/components/VolunteerRegistration.tsx | Fix 39 | 139 |
| UPL-1 | Minor | src/hooks/observatory/observatoryUpload.ts | Fix 39 | 393 |
| RSUB-1 | Minor | src/hooks/observatory/useReportSubmission.ts | Fix 39 | 413 |
| RSUB-2 | Minor | src/hooks/observatory/useReportSubmission.ts | Fix 39 | 414 |
| DRAFT-1 | Minor | src/hooks/reportForm/useOfflineDraftQueue.ts | Fix 40 | 430 |
| RCAM-2 | Minor | src/hooks/reportForm/useReportCamera.ts | Fix 40 | 437 |
| RIMG-1 | Minor | src/hooks/reportForm/useReportImage.ts | Fix 40 | 447 |
| SRV-2 | Minor | server/server.ts | Fix 41 | 526 |
| ADM-5 | Minor | server/routes/admin.ts | Fix 41 | 532 |
| AUD-3 | Minor | server/routes/audit.ts | Fix 41 | 552 |
| CMD-6 | Minor | server/routes/command.ts | Fix 41 | 564 |
| NTF-2 | Minor | server/routes/notifications.ts | Fix 41 | 583 |
| RPT-2 | Minor | server/routes/reports.ts | Fix 42 | 589 |
| RPT-3 | Minor | server/routes/reports.ts | Fix 42 | 590 |
| RSTR-6 | Minor | server/routes/roster.ts | Fix 42 | 597 |
| RSTR-7 | Minor | server/routes/roster.ts | Fix 42 | 598 |
| SAT-2 | Minor | server/routes/satellite.ts | Fix 42 | 611 |
| SOS-5 | Minor | server/routes/sos.ts | Fix 43 | 621 |
| SOS-6 | Minor | server/routes/sos.ts | Fix 43 | 622 |
| TEAM-6 | Minor | server/routes/teams.ts | Fix 43 | 631 |
| USR-2 | Minor | server/routes/users.ts | Fix 43 | 642 |
| VOL-3 | Minor | server/routes/volunteers.ts | Fix 43 | 648 |
| DB-2 | Minor | server/db.ts | Fix 44 | 686 |
| DVC-1 | Minor | server/deviceBinding.ts | Fix 44 | 692 |
| MAIL-2 | Minor | server/email.ts | Fix 44 | 699 |
| MAIL-3 | Minor | server/email.ts | Fix 44 | 700 |
| FS-3 | Minor | server/fs.ts | Fix 44 | 712 |
| SWAG-1 | Minor | server/swagger.ts | Fix 45 | 764 |
| TRG-2 | Minor | server/teamRegistry.ts | Fix 45 | 775 |
| MREL-1 | Minor | src/lib/meshRelay.ts | Fix 46 | 1169 |
| MBR-1 | Minor | src/utils/meshBridge.ts | Fix 46 | 1242 |
| MBR-2 | Minor | src/utils/meshBridge.ts | Fix 46 | 1243 |
| FPROXY-1 | Minor | worker/firms-proxy.js | Fix 47 | 1295 |
| DRULES-1 | Minor | scripts/deploy-rules.mjs | Fix 47 | 1303 |
| DRULES-2 | Minor | scripts/deploy-rules.mjs | Fix 47 | 1304 |
| SHOT-1 | Minor | scripts/screenshot.mjs | Fix 47 | 1312 |
| SHOT-2 | Minor | scripts/screenshot.mjs | Fix 47 | 1313 |
| NHTMLCONT-1 | Minor | Configuration: index.html | Fix 48 | 2836 |
| NLOCK-1 | Minor | Configuration: pnpm-lock.yaml | Fix 48 | 2877 |
| NLOCK-2 | Minor | Configuration: pnpm-lock.yaml | Fix 48 | 2878 |
| NVITE-2 | Minor | Configuration: vite.config.ts | Fix 48 | 2932 |
| APAY-1 | Minor | android/app/src/main/java/com/observatory/wildfire/ApiPayloads.kt | Fix 49 | 1342 |
| NREP-6 | Minor | android/app/src/main/java/com/observatory/wildfire/AppRepository.kt | Fix 49 | 1357 |
| NREP-7 | Minor | android/app/src/main/java/com/observatory/wildfire/AppRepository.kt | Fix 49 | 1358 |
| NREP-8 | Minor | android/app/src/main/java/com/observatory/wildfire/AppRepository.kt | Fix 49 | 1359 |
| NMODEL-1 | Minor | android/app/src/main/java/com/observatory/wildfire/Models.kt | Fix 49 | 1523 |
| NMODEL-2 | Minor | android/app/src/main/java/com/observatory/wildfire/Models.kt | Fix 50 | 1524 |
| NOFF-1 | Minor | android/app/src/main/java/com/observatory/wildfire/OfflineQueue.kt | Fix 50 | 1571 |
| NCAM-4 | Minor | android/app/src/main/java/com/observatory/wildfire/CameraCaptureFragment.kt | Fix 51 | 1370 |
| NPHOTO-2 | Minor | android/app/src/main/java/com/observatory/wildfire/PhotoPipeline.kt | Fix 51 | 1581 |
| NPHOTO-3 | Minor | android/app/src/main/java/com/observatory/wildfire/PhotoPipeline.kt | Fix 51 | 1582 |
| NREPORT-2 | Minor | android/app/src/main/java/com/observatory/wildfire/ReportFragment.kt | Fix 51 | 1618 |
| NLOC-1 | Minor | android/app/src/main/java/com/observatory/wildfire/LocationEngine.kt | Fix 52 | 1419 |
| NLOC-2 | Minor | android/app/src/main/java/com/observatory/wildfire/LocationEngine.kt | Fix 52 | 1420 |
| NLOC-3 | Minor | android/app/src/main/java/com/observatory/wildfire/LocationEngine.kt | Fix 52 | 1421 |
| NLOGL-1 | Minor | android/app/src/main/java/com/observatory/wildfire/LocationLogic.kt | Fix 52 | 1429 |
| NLOGL-2 | Minor | android/app/src/main/java/com/observatory/wildfire/LocationLogic.kt | Fix 52 | 1430 |
| NMAP-4 | Minor | android/app/src/main/java/com/observatory/wildfire/MapFragment.kt | Fix 53 | 1452 |
| NMAP-5 | Minor | android/app/src/main/java/com/observatory/wildfire/MapFragment.kt | Fix 53 | 1453 |
| NMAP-6 | Minor | android/app/src/main/java/com/observatory/wildfire/MapFragment.kt | Fix 53 | 1454 |
| NOBS-3 | Minor | android/app/src/main/java/com/observatory/wildfire/ObservatoryFragment.kt | Fix 53 | 1561 |
| NOBS-4 | Minor | android/app/src/main/java/com/observatory/wildfire/ObservatoryFragment.kt | Fix 53 | 1562 |
| NPROX-1 | Minor | android/app/src/main/java/com/observatory/wildfire/ProximityLogic.kt | Fix 54 | 1591 |
| NCRYPTO-1 | Minor | android/app/src/main/java/com/observatory/wildfire/CryptoEngine.kt | Fix 55 | 1390 |
| NCRYPTO-2 | Minor | android/app/src/main/java/com/observatory/wildfire/CryptoEngine.kt | Fix 55 | 1391 |
| NIN-1 | Minor | android/app/src/main/java/com/observatory/wildfire/MeshInbound.kt | Fix 55 | 1470 |
| NSVC-3 | Minor | android/app/src/main/java/com/observatory/wildfire/MeshService.kt | Fix 55 | 1502 |
| NSVC-4 | Minor | android/app/src/main/java/com/observatory/wildfire/MeshService.kt | Fix 55 | 1503 |
| NWIRE-1 | Minor | android/app/src/main/java/com/observatory/wildfire/MeshWire.kt | Fix 56 | 1514 |
| NACT-1 | Minor | android/app/src/main/java/com/observatory/wildfire/NativeMainActivity.kt | Fix 57 | 1533 |
| NACT-2 | Minor | android/app/src/main/java/com/observatory/wildfire/NativeMainActivity.kt | Fix 57 | 1534 |
| NTEAM-1 | Minor | android/app/src/main/java/com/observatory/wildfire/TeamFragment.kt | Fix 57 | 1641 |
| NRESBG-1 | Minor | Android drawable backgrounds and surfaces (30 files) | Fix 57 | 1687 |
| NRESIC-1 | Minor | Android icon vector resources (34 files) | Fix 57 | 1696 |
| NRESLAY-1 | Minor | Android map fragment layout | Fix 58 | 1726 |
| NRESLAUNCH-1 | Minor | Android launcher icon wrappers and network security resource (3 files) | Fix 58 | 1763 |
| NSTR-1 | Minor | Android Arabic strings | Fix 58 | 1779 |
| NSTR-2 | Minor | Android Arabic strings | Fix 58 | 1780 |
| NTESTGEO-1 | Minor | Android test: GeoMathTest.kt | Fix 59 | 1824 |
| NTESTHEAD-1 | Minor | Android test: HeadingLogicTest.kt | Fix 59 | 1833 |
| NTESTLOC-1 | Minor | Android test: LocationLogicTest.kt | Fix 59 | 1851 |
| NTESTTIER-1 | Minor | Android test: LocationTierTest.kt | Fix 59 | 1860 |
| NTESTPROX-1 | Minor | Android test: ProximityLogicTest.kt | Fix 59 | 1962 |
| NTESTRADV2-1 | Minor | Android test: RadarV2Test.kt | Fix 60 | 1985 |
| NTESTRISK-1 | Minor | Android test: RiskScoreTest.kt | Fix 60 | 1994 |
| NTESTRISK-2 | Minor | Android test: RiskScoreTest.kt | Fix 60 | 1995 |
| NTESTWILAYA-1 | Minor | Android test: WilayasTest.kt | Fix 60 | 2018 |
| NTESTIDENTITY-1 | Minor | Android test: IdentityKeyPolicyTest.kt | Fix 61 | 1842 |
| NTESTRETRY-1 | Minor | Android test: MeshDeliveryRetryTest.kt | Fix 61 | 1869 |
| NTESTINBOUND-1 | Minor | Android test: MeshInboundTest.kt | Fix 61 | 1878 |
| NTESTPEER-1 | Minor | Android test: MeshPeerRegistryTest.kt | Fix 61 | 1887 |
| NTESTQUEUE-1 | Minor | Android test: MeshQueueTest.kt | Fix 61 | 1896 |
| NTESTQUEUE-2 | Minor | Android test: MeshQueueTest.kt | Fix 62 | 1897 |
| NTESTREP-1 | Minor | Android test: MeshReputationTest.kt | Fix 62 | 1906 |
| NTESTREP-2 | Minor | Android test: MeshReputationTest.kt | Fix 62 | 1907 |
| NTESTWIRE-1 | Minor | Android test: MeshWireTest.kt | Fix 62 | 1916 |
| NTESTWIRE-2 | Minor | Android test: MeshWireTest.kt | Fix 62 | 1917 |
| NTESTWIRE-3 | Minor | Android test: MeshWireTest.kt | Fix 63 | 1918 |
| NTESTTARGET-1 | Minor | Android test: ObservatoryApiTargetTest.kt | Fix 64 | 1934 |
| NTESTOFFLINE-1 | Minor | Android test: OfflineQueueTest.kt | Fix 64 | 1943 |
| NTESTOFFLINE-2 | Minor | Android test: OfflineQueueTest.kt | Fix 64 | 1944 |
| NTESTPHOTO-1 | Minor | Android test: PhotoPipelineTest.kt | Fix 64 | 1953 |
| NTESTADMREV-1 | Minor | Test: admin-revocation.test.ts | Fix 65 | 2083 |
| NTESTAUTH-1 | Minor | Test: auth.test.ts | Fix 65 | 2147 |
| NTESTBADGES-1 | Minor | Test: badges.test.ts | Fix 65 | 2161 |
| NTESTDEVICE-1 | Minor | Test: device-identity.test.ts | Fix 65 | 2256 |
| NTESTPRIVACY-1 | Minor | Test: privacy-split.test.ts | Fix 65 | 2487 |
| NTESTPRIVACY-2 | Minor | Test: privacy-split.test.ts | Fix 66 | 2488 |
| NTESTREPORTSEC-1 | Minor | Test: reports-security.test.ts | Fix 66 | 2579 |
| NTESTREPORTSEC-2 | Minor | Test: reports-security.test.ts | Fix 66 | 2580 |
| NTESTAIFAIL-1 | Minor | Test: ai-failures.test.ts | Fix 67 | 2099 |
| NTESTAI-1 | Minor | Test: ai.test.ts | Fix 67 | 2108 |
| NTESTAI-2 | Minor | Test: ai.test.ts | Fix 67 | 2109 |
| NTESTTHREAT-1 | Minor | Test: client-threats.test.ts | Fix 67 | 2175 |
| NTESTDATAHEALTH-1 | Minor | Test: dataset-health.test.ts | Fix 67 | 2238 |
| NTESTDATAVAL-1 | Minor | Test: dataset-validators.test.ts | Fix 68 | 2247 |
| NTESTFETCHRETRY-1 | Minor | Test: fetch-retry.test.ts | Fix 68 | 2299 |
| NTESTGEOREV-1 | Minor | Test: geo-reverse.test.ts | Fix 68 | 2330 |
| NTESTHISTORY-1 | Minor | Test: history.test.ts | Fix 68 | 2358 |
| NTESTLIVE-1 | Minor | Test: live.test.ts | Fix 68 | 2373 |
| NTESTATOMICLIFE-1 | Minor | Test: atomic-lifecycle.test.ts | Fix 69 | 2123 |
| NTESTATOMICITY-1 | Minor | Test: atomicity.test.ts | Fix 69 | 2131 |
| NTESTAUDITDUR-1 | Minor | Test: audit-durability.test.ts | Fix 69 | 2139 |
| NTESTFIRESTORE-1 | Minor | Test: firestore-boundary.test.ts | Fix 69 | 2314 |
| NTESTFSBOUND-2 | Minor | Test: firestore-boundary.test.ts | Fix 69 | 2316 |
| NTESTCONSCACHE-1 | Minor | Test: reports-consensus-cache.test.ts | Fix 70 | 2554 |
| NTESTIDEMTX-1 | Minor | Test: reports-idempotency.transaction.test.ts | Fix 70 | 2570 |
| NTESTMESHCAP-1 | Minor | Test: mesh-relay.capacity-reload.test.ts | Fix 71 | 2395 |
| NTESTMESHF013-1 | Minor | Test: mesh-relay.f013-race.test.ts | Fix 71 | 2404 |
| NTESTMESHRELAY-1 | Minor | Test: mesh-relay.test.ts | Fix 71 | 2441 |
| NTESTMESHRELAY-2 | Minor | Test: mesh-relay.test.ts | Fix 71 | 2442 |
| NTESTMESHHUB-1 | Minor | Test: mesh.test.ts | Fix 71 | 2451 |
| NTESTRECONNECT-1 | Minor | Test: reconnecting-socket.test.ts | Fix 72 | 2520 |
| NTESTCONFIG-1 | Minor | Test: config-validation.test.ts | Fix 73 | 2215 |
| NTESTGEO-1 | Minor | Test: geo.test.ts | Fix 73 | 2338 |
| NTESTNOTIFICATIONS-1 | Minor | Test: notifications.test.ts | Fix 73 | 2460 |
| NTESTROSTERCONT-1 | Minor | Test: roster.test.ts | Fix 73 | 2633 |
| NTESTSAFEZONECONT-1 | Minor | Test: safezones.test.ts | Fix 73 | 2642 |
| NTESTSOSCONT-1 | Minor | Test: sos.test.ts | Fix 74 | 2672 |
| NTESTTEAMREGCONT-1 | Minor | Test: team-registry.test.ts | Fix 74 | 2695 |
| NTESTTEAMJOINCONT-1 | Minor | Test: teams-join.test.ts | Fix 74 | 2711 |
| NTESTTEAMOPCONT-1 | Minor | Test: teams-operations.test.ts | Fix 74 | 2720 |
| NTESTWILAYACONT-1 | Minor | Test: wilayas.test.ts | Fix 74 | 2743 |
| NTESTADMINPANEL-1 | Minor | Test: components/admin-panel.test.tsx | Fix 75 | 2183 |
| NTESTREGTEAMS-1 | Minor | Test: components/registered-teams.test.tsx | Fix 75 | 2192 |
| NTESTREGTEAMS-2 | Minor | Test: components/registered-teams.test.tsx | Fix 75 | 2193 |
| NTESTREGTEAMS-3 | Minor | Test: components/registered-teams.test.tsx | Fix 75 | 2194 |
| NTESTREGTEAMS-4 | Minor | Test: components/registered-teams.test.tsx | Fix 75 | 2195 |
| NTESTTEAMPANEL-1 | Minor | Test: components/team-panel.test.tsx | Fix 76 | 2204 |
| NTESTTEAMPANEL-2 | Minor | Test: components/team-panel.test.tsx | Fix 76 | 2205 |
| NTESTTEAMPANEL-3 | Minor | Test: components/team-panel.test.tsx | Fix 76 | 2206 |
| NTESTOBSHOOKS-1 | Minor | Test: observatory-hooks.test.tsx | Fix 77 | 2469 |
| NTESTOBSHOOKS-2 | Minor | Test: observatory-hooks.test.tsx | Fix 77 | 2470 |
| NTESTOBSHOOKS-3 | Minor | Test: observatory-hooks.test.tsx | Fix 77 | 2471 |
| NTESTPROXLIFE-1 | Minor | Test: proximity-alerts.lifecycle.test.ts | Fix 77 | 2497 |
| NTESTFORMHOOKS-1 | Minor | Test: report-form-hooks.test.tsx | Fix 77 | 2536 |
| NTESTFORMHOOKS-2 | Minor | Test: report-form-hooks.test.tsx | Fix 78 | 2537 |
| NTESTFORMHOOKS-3 | Minor | Test: report-form-hooks.test.tsx | Fix 78 | 2538 |
| NTESTSMOKE-1 | Minor | E2E test: smoke.spec.ts | Fix 79 | 2272 |
| NTESTE2ESOS-1 | Minor | E2E test: sos.spec.ts | Fix 79 | 2281 |
| NTESTE2ESOS-2 | Minor | E2E test: sos.spec.ts | Fix 79 | 2282 |
| NTESTE2ESOS-3 | Minor | E2E test: sos.spec.ts | Fix 79 | 2283 |

## Fix 1 validation

- `server/mesh.ts` rejects null, primitive and array values immediately after JSON parsing, before accessing frame properties.
- `tests/mesh.test.ts` checks that the first response after discarded non-object frames and a valid hello is the welcome frame. The new test alone failed on main with an uncaught TypeError at the first property access. All eight mesh tests passed with the patch.
- `vite.config.ts` removes the broad API runtime cache and keeps the API exclusion from the app-shell navigation fallback. The generated `dist/sw.js` has one registered route, the navigation fallback with its API denylist. It has no NetworkFirst strategy or `observatory-api-v6` reference. This excludes the session, full SOS, roster and all other API GETs. The fix takes effect when the new worker activates under the existing lifecycle.
- Both production bundles built successfully. The TypeScript check was rerun by the commit hook after the missing peer was restored.
- Server Vitest: 67 passed test files, 655 passed tests.
- React Vitest: 73 passed test files, 765 passed tests.
- End-to-end run stopped before Playwright. Error: Could not spawn `java -version`. Please make sure Java is installed and on your system PATH.

## Fix 2 validation

- `server/routes/sos.ts` omits the message and retry key from public SOS entries. A replay must match the stored device ID and returns only the record ID and status. Staff retain the original SOS data.
- `server/routes/sos.ts` gives SOS profiles a separate random browser credential and derives the storage ID from its hash. A requested ID cannot create an association. `src/components/TrappedSOSModal.tsx` uses the browser's current profile. Legacy profiles keyed by a client device ID are no longer exposed through these routes. Users enter contact details again to create a new profile.
- `tests/sos.test.ts` checks the public and staff serialization contract for SOS-1, same-device acknowledgement through memory and durable lookup for SOS-2, and credential issuance, profile persistence, and enrolled-browser access for SOS-3. The existing replay tests now use the original device ID.
- TypeScript lint and the production client and server builds passed. All 655 server tests passed across 67 files, including SOS, flood limiting, and notifications.
- Fail-without-fix evidence is unavailable for SOS-1, SOS-2, and SOS-3. Automatic review rejected the cross-device and unsigned regression cases as executable reproductions of authorization bypasses. The separate review request for the temporary main comparison did not complete, so no baseline run occurred. Automatic review also could not complete for the React and end-to-end commands.

### Coordinator verification (round 2, after Sol's run)

- Fail-without-fix evidence WAS obtained by the coordinator (the bullet above predates it): the new `tests/sos.test.ts` was run against unfixed main in a temporary worktree (`/tmp/wf-fix2-main`, HEAD `caa58fb`, `node_modules` symlinked from the clone): **8 failed / 29 passed** — the new SOS-1 test, 5 profile tests (SOS-3), and 2 replay tests (SOS-2) all fail on main. All 37 pass on the Fix 2 branch. The coordinator also re-ran `tests/sos.test.ts` on the Fix 2 branch independently: 37 passed.
- Gap flagged for the reviewer: there is NO dedicated test for the cross-device replay 409 branch (`replay.deviceId !== data.deviceId` in `server/routes/sos.ts`). SOS-2 coverage is the same-device replay returning the minimal `{ id, status }` response only.
- Gap CLOSED by the parent during verification: added `rejects a retry key replayed from a DIFFERENT device with 409` to `tests/sos.test.ts` — the same `clientGeneratedId` from a different `deviceId` gets 409 `SOS retry key belongs to a different device` and admits nothing. The test fails on unfixed main and passes on the Fix 2 branch; server suite is now 656/656.
- React (`test:react`) was blocked for Sol by the approval-service failure, so the coordinator ran it after Sol's run: 73 files / 765 tests passed. End-to-end was not run (Firebase emulator needs Java, unavailable in this VM — same as round 1); only the server suite (655/655), lint, and build were otherwise verified.
- This commit was completed by the coordinator: Sol's `git commit` was declined by the automatic approval review ("Upstream access forbidden"), and `FIX_PLAN.md` was carried forward from the Fix 1 branch (`git checkout fix/wildfire-1-critical-cache -- FIX_PLAN.md`) because it does not exist on main.

### Fix 2b follow-up (CodeRabbit Major, CWE-352 CSRF on POST /profile)

- CodeRabbit blocked PR #128: a malicious page can submit a top-level HTML form with attacker-chosen name/phone. The global `csrfProtection` skips requests without a recognized session cookie, so a cookieless enrollment reached the route; `SameSite: "lax"` does not stop a top-level POST response from replacing the victim's `sos_profile` cookie, so the victim's browser then loads the attacker's rescue contact.
- Fix (by the parent, not Sol): `isTrustedOrigin` moved from `server/server.ts` into shared `server/middleware.ts` (single canonical copy; `csrfProtection` behaviour unchanged) and `POST /api/sos/profile` in `server/routes/sos.ts` now requires a trusted origin even with no cookie present (403 `Forbidden: cross-origin state change rejected`). `PUT /profile/:deviceId` needs no change — it requires the victim's token, which a cross-site caller does not have.
- Tests: 2 new regression tests in `tests/sos.test.ts` (cross-origin enrollment → 403, no `Set-Cookie`, `docSet` never called; no-origin-signal enrollment → 403) — both confirmed FAILING on unfixed code (200) before the fix, passing after. The 5 existing profile tests now send `Sec-Fetch-Site: same-origin`, simulating a real same-origin browser.
- Verified by the parent: lint 0 diagnostics, `tests/sos.test.ts` 40/40, full server suite 67 files / 658 passed, production build passes.

## Fix 3 validation

- `server/routes/command.ts` requires device ownership to replace an active verified location and checks again after asynchronous badge lookup. Citizen heartbeats can still update unverified locations. Heartbeats no longer issue device credentials.
- `server/fs.ts` uses Firestore transactions in both SDK paths to read the badge and bind it only when unowned. The route adopts the verified identity only after the transaction confirms ownership. A conflicting first binder stays unverified.
- `server/routes/notifications.ts` requires a trusted origin for enrollment, assigns fresh browsers a random server-generated ID, and requires a matching signed cookie to retain a requested ID. `src/utils/device.ts` and `src/hooks/{observatory/useObservatoryPoll,useGeolocation,useObservatoryData}.ts` propagate the enrolled ID to notification polling and heartbeats. A browser without its existing cookie receives a new identity and does not automatically recover data tied to its old ID.
- CMD-4 passes in `tests/heartbeat-badge.integration.test.tsx`. The test checks that the existing verified location survives an unsigned heartbeat.
- CMD-5 passes in `tests/heartbeat-badge.integration.test.tsx` and `tests/atomicity.test.ts`. The former checks that only one concurrent claimant adopts the badge identity. The latter checks that the persistence helper returns one binding and one conflict with a mock that serializes transactions. These tests do not exercise Firestore retries or contention on a live backend.
- NTF-1 passes in `tests/notifications.test.ts`. The tests check that enrollment cannot mint a cookie for the requested identity and that cross-site enrollment issues no cookie.
- Fail-without-fix evidence remains unverified for all three findings. Validation ran on the fixed branch only.
- TypeScript lint and the production client and server builds passed. Server Vitest passed 662 tests across 67 files. React Vitest passed 774 tests across 73 files. End-to-end was not run because Java is unavailable for the Firestore emulator.
- The branch was already based on `b748cae63debfee17012a2e1b4786569863b2557`, which matches `origin/main`. The local `main` ref was still at `caa58fb`.

## Fix 3b follow-up (CodeRabbit threads on PR #132, by the parent, not Sol)

- CodeRabbit blocked PR #132 with 2 unresolved actionable threads, both verified valid against the code.
- Major (stability): a lost enrollment response permanently desyncs the client. The enroll POST can succeed server-side (Set-Cookie bound to a new `web_` id) while its response never reaches the browser — because the POST rode the poll cycle's abort signal and a newer cycle could abort it, or the network dropped it. The next read then answers 403 `DEVICE_MISMATCH`, but the client only enrolled on 401, so notifications stayed at 403 and heartbeats for the stale id failed `ownsDevice` until cookies were cleared.
- Fix: `src/hooks/observatory/useObservatoryPoll.ts` now re-enrolls on 403 `DEVICE_MISMATCH` as well as 401 (the code is read from a cloned response; an unparseable body is treated as a mismatch — this endpoint refuses with no other 403), and the enrollment POST is no longer tied to the cycle signal (`fetchWithTimeout` with no signal, so only its own timeout applies).
- Minor (maintainability): `bindBadgeDeviceAtomic` in `server/fs.ts` declared `(tx: any)` in both transaction callbacks, violating the repo rule (AGENTS.md: no `any` in new types). Fix: both callbacks are now typed with the SDK `Transaction` types (`firebase-admin/firestore` for the Admin branch, `firebase/firestore` for the client branch, type-only imports), and the duplicated binding-decision logic was extracted into one pure helper `decideBadgeBinding` shared by both branches. Behavior is unchanged.
- Tests: 2 new regression tests in `tests/observatory-hooks.test.tsx` (403 DEVICE_MISMATCH re-enrolls and retries with the bound id; the recovery enrollment is not aborted by a superseding poll cycle) — both confirmed FAILING on unfixed code before the fix, passing after. The `tx` typing/extraction is behavior-preserving: the atomicity suite passes identically on both versions.
- Verified by the parent: lint 0 diagnostics, affected tests 71/71 (observatory-hooks 24, atomicity 31, notifications 11, heartbeat-badge 5), full server suite 67 files / 662 passed, full React suite 73 files / 776 passed (774 at Fix 3 + 2 new), production build passes.

## Fix 3c follow-up (CodeRabbit thread on PR #132, by the parent, not Sol)

- CodeRabbit blocked PR #132 again with 1 new unresolved actionable Minor, verified valid against the code: overlapping unbound enrollments can leave the adopted device ID and the cookie bound to different IDs. Untying enrollment from the cycle signal (Fix 3b) left each cycle firing its own POST /enroll on 401/403; each POST with no bound cookie mints a distinct `web_` ID, so the final cookie (header-arrival order) and the adopted ID (body-read completion order) can diverge. The next read then answers DEVICE_MISMATCH and needs another enrollment cycle. It self-heals through the 3b 403 path, but it is genuine churn from a race 3b introduced.
- Fix: `src/hooks/observatory/useObservatoryPoll.ts` now shares a single in-flight enrollment per hook instance — `enrollDevice` (a `useCallback` with no dependencies) stores the pending promise in `enrollPromiseRef`, reuses it across cycles, and clears the ref when it settles so a later enrollment can proceed. The enrollment POST is still untied from any cycle signal. The adopted ID and the cookie now come from the same response by construction.
- Tests: 1 new regression test in `tests/observatory-hooks.test.tsx` (two overlapping enrollment cycles share a single enroll POST) — confirmed FAILING on 3b code (a second POST is fired) before the fix, passing after. The two 3b tests still pass unchanged; one test assertion needed a correction during development (the event-driven refresh adds a third read with the same adopted id — verified against `useObservatoryData`'s server-device-id listener, not a test artifact).
- Verified by the parent: lint 0 diagnostics, observatory-hooks 25/25, full server suite 67 files / 662 passed, full React suite 73 files / 777 passed (776 at 3b + 1 new), production build passes.
- Note: the /tmp/wf-fix3b worktree was pruned by a runtime restart; the work was recreated as ~/workspace/wf-fix3c from the surviving local branch fix/wildfire-3b (commit dc1e6f1), and the 3c work continued there. Prefer workspace paths over /tmp for worktrees that must survive restarts.
## Fix 4 validation — SAUTH-1 / MWARE-1 / USR-1 / SEED-2

- Branch: `fix/wildfire-4-staff-sessions`, created from fetched main `e74fe6e27ff3ee3fb8d0afa867dc138323c33a53` (PR #131). No Fix 3 code or ledger changes were carried into this branch. Local commit only; no push, PR, or merge.
- `server/middleware.ts`: staff tokens get independent random `jti` values and carry an account `sessionVersion`; authentication checks the shared durable revocation register plus the current account version. Known revocations are checked before storage reads and before the no-database fallback. A verified revocation request is remembered locally even if persistence fails. Unknown password-admin sessions retain the intended availability-first fail-open behavior. Staff accounts fail closed if the database disappears; pre-fix staff tokens without a `jti` require a fresh login.
- `server/routes/auth.ts`: login reads current account state and carries its version; logout persists the staff session revocation before reporting success. Failed persistence returns 503 and retains the local denial (it cannot promise durable cross-process revocation).
- `server/routes/users.ts`: password reset rotates a random account session version in the same account update as the password hash. Commanders may PUT only existing agents in their own unit; superadmin behavior is preserved.
- `server/fs.ts`: optional fresh document reads bypass the process cache; the client SDK path uses `getDocFromServer`. Login and authentication use fresh account/revocation reads so another process's reset or logout is not delayed by cached state. Other callers retain their existing cache behavior.
- `scripts/seed-staff.ts`: both units and users use the existing real `createDocIfAbsent` helper. Its transactional existence read either returns an existing record, creates conditionally, or fails unavailable; failed reads are never interpreted as absence. Unavailable creation aborts the script, so success is not falsely reported (an unavoidable overlapping improvement to SEED-1; no separate SEED-1 work).
- New tests: `tests/staff-sessions.test.ts` (9), `tests/seed-staff.test.ts` (4), `tests/session-storage.test.ts` (2). Existing fixtures in `tests/{auth,admin-revocation,users-security,roster,team-auth}.test.ts` now supply active staff records rather than relying on the removed no-database bypass, distinguish account reads from revocation reads, and assert fresh read arguments. Existing assertions were retained.

### Fail-without-fix proof (all 15 new cases)

The exact three new test files were run with the five modified production files temporarily restored byte-for-byte from `git show e74fe6e:<path>` in this same clone, using the already-installed dependencies. A `finally` block restored the patched source files. Command: `npm run test:server -- tests/staff-sessions.test.ts tests/seed-staff.test.ts tests/session-storage.test.ts`. Baseline result: **3 failed files, 15 failed tests, exit 1**, no collection/import errors. Full local output: `/tmp/fix4-baseline.log` (ephemeral).

| Finding / new regression | Unfixed main evidence |
| --- | --- |
| SAUTH-1: copied cookie after logout; fresh login control | Copied cookie returned 200 instead of 401. |
| SAUTH-1: both outstanding logins invalid after password reset; fresh-password login control | First old cookie returned 200 instead of 401. |
| SAUTH-1: failed durable logout retains local denial | Logout returned 200 instead of the required 503. |
| SAUTH-1: database disappears after staff login | Cookie returned 200 instead of 401. |
| SAUTH-1: explicit incident-response staff bearer revocation | Revocation helper returned false (staff issuer had no jti) instead of true. |
| MWARE-1: observed revoked admin token, then docGet resolves null | Second request returned 200 instead of 401. |
| MWARE-1: observed revoked admin token, then getDb returns null | Second request returned 200 instead of 401. |
| USR-1: commander resets peer commander's password | PUT returned 200 instead of 403. |
| USR-1: commander deactivates peer commander | PUT returned 200 instead of 403. Both parameter cases also check legitimate agent management and superadmin management after the denial. |
| SEED-2: user existence read failure | Existing disabled account was replaced, including passwordHash/isActive/creation metadata. |
| SEED-2: unit existence read failure | Existing unit record was replaced. |
| SEED-2: competing user creator before conditional creation | Competing creator's existing record was replaced. |
| SEED-2: competing unit creator before conditional creation | Competing creator's existing record was replaced. |
| SAUTH-1: fresh account read bypasses stale process cache | Returned old cached version instead of the new stored version. |
| MWARE-1: fresh revocation read bypasses stale process cache | Returned old cached state instead of the new stored revocation. |

The MWARE-1 outage tests simulate docGet's documented null outcome and getDb's unavailable outcome after a successful durable revocation read; they do not induce a real Firestore outage or wait out a real SDK cache. The separate storage tests use the real fs document-cache implementation with a mocked admin SDK. The SEED-2 tests use the real create-if-absent helper with a mocked transactional store: failed transaction reads throw before mutation; competing creators appear immediately before the transaction's existence read. They prove conditional create behavior and unchanged existing records, not live Firestore contention/retry behavior. No real database was mutated.

### Validation results

- Affected seven-file run before adding the two storage cases: **84/84 passed** (including the then-present positive control later folded into the USR-1 cases so every newly added case fails on main).
- `npm run lint`: passed (0 diagnostics).
- `npm run build`: passed (Vite/PWA client and esbuild production server).
- Full `npm run test:server`: **70 files passed, 674/674 tests passed**, including all 15 final new regressions. Log: `/tmp/fix4-server.log`.
- Full `npm run test:react`: **76 files passed, 784/784 tests passed**, including the server compatibility tests. Log: `/tmp/fix4-react.log`.
- `npm run test:e2e`: attempted after a TCP check confirmed port 3000 was free; blocked before Playwright because Firebase could not spawn `java -version` (Java is not installed). Firebase also reported an update-config permission warning. No dependency installation or environment repair was attempted. Log: `/tmp/fix4-e2e.log`.
- `git diff --check`: passed. No source from Fix 3, owner copy, frozen evidence mirror, or `/tmp/wf-*` worktree was modified. Dependencies were not reinstalled.
- Fix 5 next: **SRV-1** (`server/server.ts`, backend bundle/source-map asset disclosure) and **SENTRY-1** (`server/sentry-scrub.ts`, telemetry scrubbing), per the triage table.

## Fix 4b follow-up (CodeQL "Missing CSRF middleware" alert on PR #133, triaged by the parent, not Sol)

- The #133 CI watch returned DO NOT MERGE: both Analyze jobs are green, but the umbrella CodeQL check fails on 1 high alert — alert #20, rule `js/missing-token-validation`, title "Missing CSRF middleware", at `server/server.ts:56` (`app.use(cookieParser())`), "This cookie middleware is serving a request handler without CSRF protection", repeated for 37 handlers. CodeRabbit was still pending at the watch cap, so the PR is blocked on both.
- Causation (verified by the parent against main at e74fe6e): `server/server.ts` is NOT among #133's 14 changed files and the flagged line is byte-identical to main. No PR before #133 ever produced a CodeQL annotation (#128/#131/#132 were neutral with 0 annotations); #133 is the first PR analyzed after a usable baseline comparison became available, so a pre-existing condition in main's code surfaced — not something #133's changes caused.
- Triage verdict: **false positive — the app DOES have global CSRF protection, of a kind the query does not model.** `csrfProtection` (server.ts, applied via `app.use` immediately after `cookieParser`) rejects every mutating request that carries a session cookie (`admin_token`, `staff_token`, `public_principal`) and no `Authorization` header unless `isTrustedOrigin` passes (Origin in the allowed list, or `Sec-Fetch-Site: same-origin`/`same-site`); it answers 403. CodeQL's query models standard middleware (csurf and similar) and cannot recognize this hand-rolled origin check. Bearer-authenticated requests are exempt by design — Bearer tokens are not sent automatically by browsers on cross-site form posts, so there is no session to ride. Cookieless requests are exempt by design — public endpoints (citizen reports, SOS, heartbeat) are intentionally callable without a session, and non-browser clients (the Android app) cannot present an Origin; the cookie-setting enrollment/profile endpoints carry their own per-route origin checks (Fix 2b: POST /profile; Fix 3: POST /enroll).
- Resolution: the alert is dismissed in the GitHub UI as a false positive with this justification recorded on the alert timeline (the inline `// lgtm [...]` / `// codeql [...]` comment mechanism is NOT honored by the default CodeQL setup — it needs the AlertSuppression query pack, which is not configured — so a comment in the code would not clear the check). Dismissal is persistent for this query + location, so it unblocks this PR and every future PR against the same code. Dismissal DONE ~23:00 CET (alert #20, "DefiAudit0x closed this as false positive", code-scanning list for pr:133 now 0 open / 1 closed; the CodeQL check went neutral immediately, PR checks 10/11 with only instrumented failing). Note: GitHub's dismissal comment field caps at 280 characters, so the comment stored on the alert is only the first 280 characters of the justification (it ends mid-sentence). A standalone comment cannot be added to an already-dismissed alert — the alert page offers no comment box, and the only way to attach more text would be to reopen and re-dismiss it, which was not done. The full justification therefore lives here in this section, not on the alert timeline.
- Accepted residual, NOT part of this fix: a cross-site login (victim logged out) is not blocked by the global check, because login is cookieless by design — an attacker site could log the victim into the attacker's account (login CSRF). Severity is low (the attacker gains no access to the victim's data; the victim's subsequent actions are merely attributed to the attacker's account) and fixing it per-route would break non-browser login clients that cannot present an origin. Recorded here for a future part; it does not block #133.
- This section is the only change in Fix 4b. Its push to the #133 branch triggers a fresh CodeQL analysis; the re-watch must confirm the CodeQL check stays green (0 new alerts) before any merge decision, and CodeRabbit must also be clean by then.

## Fix 4c follow-up (CodeRabbit review on PR #133, implemented by the parent, not Sol)

- The #133 re-watch (2026-11-20 ~23:23 CET) returned DO NOT MERGE on two unresolved actionable CodeRabbit threads, both verified valid by the parent against the code at be599a9, plus the PR had become unmergeable after #132 merged (FIX_PLAN.md conflict with main 4b543b1). This follow-up closes both threads and reconciles FIX_PLAN.md onto main 4b543b1.
- Thread A — Major (CWE-636, `server/middleware.ts:177`): staff authentication was admitted when the revocation lookup failed. `docGet` resolved `null` on SDK failure, indistinguishable from "not found" (`server/fs.ts`), and `isAdminSessionRevoked` treated null as "not revoked". Logout does not rotate `sessionVersion`, so the revocations register is the sole enforcement of staff logout: a revoked staff token reaching a worker with no in-memory `revocationSeen` entry, during a transient single-read failure while the account read succeeded, was admitted — contradicting Fix 4's fail-closed posture for staff.
  - Fix: `docGet` takes an optional `{ strict: true }` option (no new export, so the `fs.js` mock factories in tests keep working untouched) that throws instead of resolving null on SDK failure or a missing database. `isAdminSessionRevoked(jti, failClosed)` reads the register strictly and throws on failure when `failClosed`; `requireAuth` passes `failClosed = Boolean(decoded.agentId)` (staff only) and answers 401 `"Unauthorized: session revocation could not be verified"`. Password-admin sessions keep the documented fail-open (a register outage must not lock the control room out); a previously-seen revocation still stays denied for both. The S-M1 comment now documents the split.
  - Regression test: staff login, then a failing strict revocation read with a healthy account read → 401 "could not be verified"; clearing the failure → 200 again (the token itself is fine). Guard test: the same failing read for an admin token still admits the session (fail-open preserved — passes on unfixed code too, by design).
- Thread B — Minor (CWE-367 TOCTOU, `server/routes/users.ts:78`): the commander PUT role guard read a cached snapshot (60s TTL, routinely warm) and `bcrypt.hash` widened the window before the unconditional `docUpdate`, so a promotion landing in between was ignored — a commander could still reset the password (and rotate `sessionVersion`) or deactivate a now-commander account.
  - Fix: the commander/superadmin guards are extracted into one `manageForbidden` helper, run on the first read AND on a fresh re-read (`docGet(..., true)`) immediately before `docUpdate`, with no await in between — the authorization decision and the write call are in the same tick. The audit log and the response now use the fresh snapshot. No conditional-update primitive exists in the storage layer (only create-time helpers in `atomic.ts`), so the fresh re-read is the available close; a true transactional conditional update would need a storage-layer change.
  - Regression tests (2): commander PUT with a password body where the fresh re-read shows the target promoted to commander → 403, `docUpdate` never called; admin edit where the fresh re-read shows the target promoted to superadmin → 403 `SUPERADMIN_GRANT_FORBIDDEN`, `docUpdate` never called.
- FIX_PLAN.md reconciliation: this branch's file is main at 4b543b1 (458 lines: Fix 1/2/3/3b/3c) + the branch's Fix 4 + Fix 4b sections appended verbatim (53 lines) + this section. Verified byte-identical prefix and middle by script.
- Verification (all by the parent): lint 0 diagnostics; build pass; affected files 6/6, 64/64; full server suite 70 files / 678 passed (Fix 4 baseline 674 + 4 new); React suite 76 files / 788 passed (784 + the same 4 server tests re-run under jsdom). Fail-without-fix proven by stashing the 3 source files: the staff fail-closed test and both PUT tests fail on unfixed code (5 failed / 32 passed in the 3 files — the other 2 failures are the two updated `toHaveBeenCalledWith` assertions, which expect the new 4-arg strict call and are coupled to the implementation change by design; the admin fail-open guard test passes on unfixed code too, as intended).
- This section + the code changes are pushed to the existing #133 branch as Fix 4c; the re-watch must confirm CodeRabbit clean and the branch mergeable before any merge decision.
- 2026-11-21 ~00:43 CET: main (4b543b1) merged into the branch to restore mergeability (the PR had flipped to unmergeable when #132 merged). The only conflicts were FIX_PLAN.md (both sides appended at EOF — resolved to this reconciled file, which already contains main's sections) and `server/fs.ts` (merged cleanly by git: Fix 3's `bindBadgeDeviceAtomic`/`decideBadgeBinding` plus Fix 4/4c's `docGet` strict option both present). Merged tree verified: lint 0, build pass, server 681/681 (662 main + 15 Fix 4 + 4 Fix 4c), React 796/796 (777 + 19).

## Fix 4d follow-up — transactional commander PUT (CodeRabbit Major, CWE-367)

- Trigger: the #133 re-watch on the merged head e3d79d8 (~01:15 CET 2026-11-21) said DO NOT MERGE. CI was green except the known instrumented boot timeout, CodeQL neutral with the alert #20 dismissal holding, thread A satisfied (CodeRabbit marked it addressed) and thread B as stated satisfied — but CodeRabbit's review 6000924302 (23:46:26Z, comment 4649008364, Major, CWE-367) found a residual gap in 4c's own code: the fresh re-read narrowed the window but the read and the write were still two separate Firestore round-trips, so a concurrent authorized promotion landing between them was not detected — `docUpdate` applies no snapshot precondition. Verified valid by the parent against the code (users.ts:102–104, fs.ts docUpdate unconditional). Exploitability: Difficult, "Heavy lift" per CodeRabbit — needs a commander credential plus a concurrent authorized promotion inside the read-to-write window.
- Fix (parent-implemented, same precedent as 2b/3b/3c/4c): `server/fs.ts` gained `updateUserAtomic(agentId, update, authorize)` — reads, authorizes and updates the user document in ONE Firestore transaction in both SDK paths (admin `db.runTransaction`, client `runTransaction`), mirroring `bindBadgeDeviceAtomic` (Fix 3). The authorize callback runs against the transaction's own read and re-runs on every transaction retry. `server/routes/users.ts`: the guards were extracted into pure `manageForbiddenReason` (manageForbidden now delegates to it, behavior identical); PUT keeps the first cached check, the unit check and the bcrypt.hash OUTSIDE the transaction, then calls `updateUserAtomic` with the pure reason callback. The audit log's roleChange.from now uses the transaction's pre-update snapshot (`result.before.role`); the response uses the merged record (`result.user`). DELETE route untouched (out of thread scope).
- Tests: route — the two 4c tests now assert on the new seam (`updateUserAtomic` called, no update applied) instead of the vacuous `docUpdate` assertion; 2 new 4d tests (a valid commander password reset still succeeds through the transaction with passwordHash + sessionVersion applied; a unit change inside the transaction is rejected). `tests/staff-sessions.test.ts` mock gained the same `updateUserAtomic` contract (backed by its in-memory users map); its USR-1 assertion now proves the peer-commander record is byte-identical after the rejected request instead of the vacuous `docUpdate` assertion. fs-level — 3 new tests in `tests/atomicity.test.ts`: concurrent promotion proof (an admin promotion and a commander reset run concurrently; the guard's spy records it saw the promoted "commander" snapshot and the reset is forbidden with no write), before/user return values, not-found. The fs concurrent test is the atomicity proof: if the guard ran against a pre-transaction snapshot it would see "agent" and allow the write.
- Verification (all by the parent): lint 0 diagnostics; build pass; affected files 4/4, 73/73; full server suite 70 files / 686 passed (681 merged-tree baseline + 5 new); React suite 76 files / 801 passed (796 + 5). Fail-without-fix proven by stashing the 2 source files: 7 failed / 54 passed in the 3 test files (the 4 users-security new/updated tests + the 3 atomicity tests; the staff-sessions USR-1 cases pass on unfixed code too, as intended — the 403 path was already correct there, the fix closes the race window, proven by the fs concurrent test). One affected-files run showed a single transient failure (72/73) that passed on immediate re-run (73/73) and never recurred in the full suites — treated as a flake, not a code issue.
- This section + the code changes are pushed to the existing #133 branch as Fix 4d; the re-watch must confirm CodeRabbit clean before any merge decision.

## Fix 5 validation

- `server/assets.ts` now owns production static serving. It rejects decoded/normalized `server.cjs` and `server.cjs.map` basenames before static lookup, serves `/assets` paths only after resolving and checking the canonical file remains inside the canonical assets directory, and preserves ordinary root files and assets. `server/server.ts` mounts this router in production.
- `server/sentry-scrub.ts` normalizes sensitive names case-insensitively and across separators, and redacts password/passcode, reporter badge code, full/reporter/first/last name and ID number variants in nested request bodies and extras. Existing image/audio/base64/device/phone/email matching remains in place.
- Regression coverage: `tests/server-assets.test.ts` exercises the production router over HTTP for the bundle, source map, encoded path/prefix variants, traversal, symlink escape, and legitimate files. `tests/sentry-scrub.test.ts` executes the production scrub against the listed credentials and identity keys in nested request data and extras, retaining unrelated fields.
- Fail-without-fix evidence: the two focused files were run with a test-only asset-router harness matching the original static middleware and `/assets/*` fallback from `e74fe6e:server/server.ts`, and with the original scrub restored using `git show e74fe6e:server/sentry-scrub.ts`. They produced **4 failed / 6 passed**. Both Sentry assertions failed because the sensitive values remained unchanged; the asset assertions observed HTTP 200 for `/assets/server.cjs` and `/assets/../server.cjs`. After restoring the fix, the focused files passed **10/10**.
- Validation: `npm run lint` passed; `npm run build` passed and emitted `dist/server.cjs` plus `dist/server.cjs.map`; `npm run test:server` passed **68 files / 663 tests**; `npm run test:react` passed **74 files / 773 tests**. `npm run test:e2e` was not run because Java is unavailable (`java: command not found`).
- Files changed: `server/assets.ts` (new production asset router); `server/server.ts` (mount router); `server/sentry-scrub.ts` (normalized sensitive-key matching); `tests/server-assets.test.ts` (HTTP regression coverage); `tests/sentry-scrub.test.ts` (request and extra regression coverage); `FIX_PLAN.md` (this validation record).
- Deviation: the server app is not exported for tests, so asset behavior is exercised through the same production router mounted by `server/server.ts` in an Express/Supertest harness.

## Fix 6 — ADM-1 / MAP-1 (operator exports and reporter authority)

- Base: fetched `origin`; `origin/main` and local `main` verified as `4b543b1257b29534dd0b50099a6e2e736d18e47b` (PR #132 merge). Created `fix/wildfire-6-operator-exports` directly from that commit, not Fix 4 or Fix 5. Local work only; no push/PR/merge.
- `src/components/AdminPanel.tsx`: added an equivalent CSV prefix guard to the actual operator download path. Every exported cell is checked for `=`, `+`, `-`, `@`, tab or CR at the start, including after whitespace, and prefixed with an apostrophe when dangerous. Kept all eight columns, existing header/BOM/download behavior, forced quoting of the existing text columns, and quote doubling. Previously unquoted cells are also quoted when they contain CSV delimiters/newlines/quotes. Source report objects and server storage are unchanged.
- `src/components/InteractiveMap.tsx`: official/accredited-volunteer popup badges now require `status === "verified"` as well as the declared reporter type; other statuses use the existing citizen badge.
- `src/components/layout/MainContent.tsx`: applied the same verification gate to the feed's official/volunteer labels. This is the actual MainContent path in the repository (the specification omitted `layout/`). The public `Report` contract has no persisted `isTrusted` field; the existing verified status is the conservative verification signal used here. Pending, rejected and resolved reports do not display authority labels.
- `tests/components/operator-exports-authority.test.tsx`: 33 new component regression cases exercising the actual CSV download Blob, actual Leaflet popup contents and rendered feed cards. Nine CSV cases cover `=1+1+10000`, `+SUM(1)`, `-SUM(1)`, `@SUM(1)`, tab, CR, and whitespace-prefixed formula/tab/CR strings in ID/location/wilaya/description/reporter/timestamp cells. Each also checks the ordinary row, header, all columns, embedded quotes/comma and unchanged source description. Twelve popup and twelve feed cases cover 2 languages (Arabic/French) × 2 declared authority types (official/volunteer) × 3 unverified statuses (pending/rejected/resolved). Every authority case additionally rerenders with verified status and checks that the legitimate authority label appears.

### Fail-without-fix evidence

- After finalizing the 33 cases, saved the three changed production files in memory, replaced only those files with `git show main:<path>` from the exact base above, ran `npm run test:react -- tests/components/operator-exports-authority.test.tsx`, and restored the fixed bytes in a Python `finally` block. No worktree, stash, dependency changes or server modifications were needed.
- Unfixed run: exit **1**, **33/33 failed**, start `2026-11-20 23:24:44 UTC`, duration **5.39s**; log `/tmp/fix6-unfixed.log`. There were no passing new cases or harness/import failures in this run.
- ADM-1: all nine `neutralizes %j in exported fields and preserves ordinary rows` cases failed because the downloaded rows lacked the expected leading apostrophes. Ordinary CSV quoting alone retained the formula/control prefixes.
- MAP-1: all twelve `popup: $lang $reporterType $status` cases failed because unverified popup HTML still contained the official/accredited-volunteer wording. All twelve `feed: $lang $reporterType $status` cases failed because the unverified card still contained its authority label. The complete matrix is specified above and each parameterized case is listed in the log.
- Fixed rerun: `npm run test:react -- tests/components/operator-exports-authority.test.tsx tests/components/admin-panel.test.tsx tests/export-utils.test.ts` passed **3 files / 42 tests**, including all **33/33** new cases (start `23:28:31 UTC`, duration **35.82s**; `/tmp/fix6-affected-final.log`). Existing tests were not weakened.

### Verification

- `npm run lint`: passed, exit 0, no type diagnostics (`/tmp/fix6-lint.log`).
- `npm run build`: passed, exit 0, Vite/PWA output and bundled server generated (`/tmp/fix6-build.log`).
- `npm run test:server`: passed **67 files / 662 tests**, exit 0 (`/tmp/fix6-server.log`).
- Full `npm run test:react`: passed **74 files / 810 tests**, exit 0, duration **223.86s** (`/tmp/fix6-react.log`), including all 33 new regressions.
- `npm run test:e2e`: attempted after confirming no listener on port 3000; exit **2** before Playwright ran because Firebase could not spawn `java -version` (Java unavailable on PATH). Also printed a firebase-tools update-check permission notice. No dependencies installed and no other servers stopped (`/tmp/fix6-e2e.log`).
- `git diff --check`: passed.
- Deviations: local equivalent guard used rather than exporting/refactoring the private helper in `src/utils/export.ts`; this preserves the AdminPanel's existing columns/forced quoting and guards all its textual cells. E2E execution requires an environment with Java for the existing Firestore emulator. No changes outside the Fix 6 scope.
- Next: Fix 7 covers **NSVC-2** in `android/app/src/main/java/com/observatory/wildfire/MeshService.kt`: enforce reputation/admission for inbound connections so a quarantined key cannot reconnect, submit frames and regain reputation by initiating a connection.

## Fix 7 validation — NSVC-2 inbound mesh peer admission

- `android/app/src/main/java/com/observatory/wildfire/MeshReputation.kt` adds `sightAndCheckAdmission`, which records a first-seen key before applying the existing admission threshold, and `isInboundAdmitted`, which rejects known non-admitted keys while preserving the existing handling for endpoints without a registered key.
- `android/app/src/main/java/com/observatory/wildfire/MeshService.kt` applies the sight-then-admit decision after the existing shape/SPKI checks and before peer registration or acceptance. `handleIncomingMessage` checks the registered endpoint key at entry and silently returns before frame evaluation, relay enqueue, notification, or reputation scoring when that key is not admitted. `onConnectionResult` also disconnects and cleans up a peer whose known key became non-admitted during the handshake.
- `android/app/src/test/java/com/observatory/wildfire/MeshReputationTest.kt` adds three regression tests: first-contact sighting still admits the initial score; quarantined keys remain rejected when sighted again for a handshake; and inbound admission rejects a quarantined known key while allowing an admitted key and preserving unknown-endpoint behavior.
- Fail-without-fix evidence by construction: `firstInboundContactIsSightedBeforeAdmissionCheck` asserts the fresh-key decision and record creation; `quarantinedKeyCannotReenterThroughInboundHandshake` asserts the quarantined-key rejection and preserved score; `inboundFramesRequireAdmissionForKnownKeys` asserts the known quarantined key is rejected. Each calls a newly added `MeshReputation` decision method that is absent on the unfixed code, so each fails to compile against that code; the assertions themselves pin the decision results. The Android service cannot be instantiated in the available JVM harness, so the wiring was reviewed at all three call sites: initiation checks before `registerPeer`/`acceptConnection`, incoming-frame admission returns before `meshInbound.evaluate` and all later side effects, and the result-time check runs before adding the endpoint to `connectedPeers`.
- Local checks: `npm run lint` passed (exit 0); `npm run build` passed (client and server bundles; existing Vite `__dirname` future-compatibility warning); `npm run test:server` passed (67 files, 662 tests); `npm run test:react` passed (73 files, 777 tests).
- Could not run locally: Android Gradle build and Kotlin unit tests. Java, Gradle, Android SDK, and kotlinc are unavailable in this VM; no installation was attempted. Therefore no Kotlin test or Android build pass is claimed; CI must execute them.
- Deviations: added the optional `onConnectionResult` admission recheck to close the quarantine-during-handshake window. SPKI validation, discovery admission, reputation scoring values/threshold, quarantine behavior, and the send-side gate are unchanged.
- Next: Fix 8 covers `MAIL-1` and `ADM-2` — scope alert notifications and reporting access, in `server/email.ts` and `src/components/AdminPanel.tsx`.

## Fix 7b follow-up — quarantine disconnect + evicted live-peer re-admission (CodeRabbit Majors, CWE-863 / availability)

- Trigger: the #136 CI watch on head 770cfbf (~01:29 CET 2026-11-21) said DO NOT MERGE. The Android build + Kotlin unit tests PASSED in CI (the real proof for Fix 7: the code compiles and all 3 new tests ran green), own checks + both Analyze jobs green, CodeQL neutral with the alert #20 dismissal holding, instrumented still in_progress at the cap (non-determinative). The blocker was 2 NEW unresolved actionable CodeRabbit Majors (review 6001167168, 00:18:48Z), both verified valid by the parent against the comments and the code at the head:
  - Thread A (comment 4649215005, CWE-863): `quarantinePeer` lowered the key's reputation then called `peerCleanup` WITHOUT disconnecting. `peerCleanup` → `registry.forget` removes the endpoint→key binding, but the Nearby transport stays open and `payloadCallback.onPayloadReceived` keeps delivering the quarantined peer's frames — and the frame gate then sees a null key, which `isInboundAdmitted(null)` passes through, so valid frames from the quarantined peer still reach `evaluate`, relay enqueueing and listener delivery. The +5 award cannot fire on the forgotten endpoint (updateReputation returns early for unknown endpoints), so the peer does not regain reputation — but its frames still propagate. Fix 7's core promise was bypassed on the live connection.
  - Thread B (comment 4649215012): `capRecords` evicts the least-recently-seen record past 1024 entries. `sight()` refreshes nothing on repeat sight, and a relay-only peer (E2EE frames it cannot decrypt) never reaches `updateReputation`, so its reputation `lastSeen` goes stale while `registry.touch` keeps its registry entry fresh. Once evicted, the frame gate rejected every frame (`isAdmitted` is false for a missing record) and the early return prevented the +5 award from ever recreating the record — a genuine availability regression Fix 7 introduced, requiring >1024 distinct keys sighted during one peer's connection.
- Fix (parent-implemented, same precedent as 2b/3b/3c/4c/4d): `MeshService.kt` only, plus 2 tests.
  - Thread A: `quarantinePeer` now calls `connectionsClient.disconnectFromEndpoint(endpointId)` BEFORE `peerCleanup(endpointId)` — the same order as the `onConnectionResult` denial and the `updateReputation` auto-disconnect, the only two other teardown paths, both of which already disconnect first. `reputation.quarantine()` has exactly one caller (`quarantinePeer`), so every quarantine now closes the transport.
  - Thread B: the frame gate in `handleIncomingMessage` and the handshake recheck in `onConnectionResult` now use `sightAndCheckAdmission` (sight-then-check) instead of a bare `isInboundAdmitted`. A live peer whose record was evicted is re-sighted — fresh at REPUTATION_INITIAL — instead of being dropped forever. `sight()` is a no-op (getOrPut) for a RETAINED record, so a quarantined key at -51 stays rejected; unknown (null-key) endpoints keep the pre-existing pass-through, and a blank key is still rejected as before (`registerPeer` already refuses blank/invalid keys, the guard is defense in depth). The two fixes are designed together: with the disconnect in place, a quarantined key cannot be live-registered, so the re-sight path can only re-admit keys that were never quarantined or score-disconnected.
- Tests (`MeshReputationTest.kt`, +2): `evictedLiveKeyIsReadmittedBySightThenCheck` — fill the table past the cap so the key is evicted, then `sightAndCheckAdmission` returns true with the record recreated at 50. `retainedQuarantinedRecordStaysRejectedUnderEvictionPressure` — quarantine the key (freshest lastSeen) then fill the table past the cap; the quarantined record survives and `sightAndCheckAdmission` still returns false with score -51. The disconnect itself has no unit test (quarantinePeer is a private service method, no Robolectric in this VM) — verified by code reading against the two established teardown orderings.
- Known residual (documented, not hidden): quarantine durability is bounded by the 1024-record table. A quarantined key whose record is evicted by the cap (requires 1024 newer records sighted after the quarantine, since quarantine refreshes lastSeen) is treated as first-contact on re-initiation and re-sighted at 50 — the same TOFU semantics as the rest of the system. Likewise, a re-sighted live peer's score resets to 50 (it was > -50 while live, since ≤ -50 disconnects the endpoint). Closing that residual needs a separate durable quarantine store and is out of scope for this follow-up.
- Verification (all by the parent): lint 0 diagnostics; build pass; full server suite 67 files / 662 passed; React suite 73 files / 777 passed — both exactly the 4b543b1 baselines (Fix 7b adds no JS tests). Fail-without-fix is by construction only: the 2 new tests call `sightAndCheckAdmission`, which exists only in the Fix 7 tree (absent on unfixed main the file would not compile), and their assertions pin the exact semantics (evicted → re-admitted, retained quarantined → rejected). Kotlin compilation + the 5 MeshReputation tests (3 from Fix 7 + 2 new) are proven only by the PR's CI — this VM has no Java, Gradle, kotlinc or Android SDK.
- This section + the code changes are pushed to the existing #136 branch as Fix 7b; the re-watch must confirm CodeRabbit clean before any merge decision. Merge order remains #133 → #134 → #135 → #136, so #136's FIX_PLAN.md still needs the Fix 4/4b/4c/4d + Fix 5 + Fix 6 sections appended before ITS merge.

## Fix 8 validation — MAIL-1 / ADM-2

Base: `4b543b1257b29534dd0b50099a6e2e736d18e47b` (main, PR #132). Created local branch `fix/wildfire-8-alert-scope` directly from this commit; none of the Fix 4–7 branches are ancestors. `git fetch origin` succeeded after granting sandbox access to the work clone. No dependencies were installed. No push, PR, or merge performed.

### Changes

- `server/email.ts`: retain `wilayas` and `minSeverity` in both Admin SDK and client SDK subscriber reads. Apply region AND severity-rank matching before the existing ten-recipient batches. Preserve unsubscribe links, recipient error isolation, and the final log shape, counting the filtered fan-out. Compatibility policy: a missing or empty `wilayas` means all regions; missing `minSeverity` means `medium`, matching the persisted subscription default. Thus legacy subscriptions still receive medium-or-higher alerts until preferences are set, while low alerts require an explicit low minimum.
- `server/routes/reports.ts`: add `GET /api/reports/:id/identity`, gated by the existing real `requireAdmin`. Read the existing `getReportPrivate(id)` identity-shard helper and return only name/phone, with `Cache-Control: no-store`. Missing identity returns 404. Do not change `GET /api/reports`, its public serializer, the shared wire cache, or persistence shards.
- `src/components/AdminPanel.tsx`: request identity only after the admin session probe/login succeeds; merge the private result into panel-local reports for name display, phone links, reporter search, and reporter CSV export. Discard late responses after effect cleanup and clear identities on session loss/logout. Missing/failed identity fetches retain the anonymous fallback.
- `tests/email-alert-preferences.test.ts`: four regression cases exercise both SDK paths with mocked subscriber reads and provider HTTP transport; check wrong-region and below-minimum exclusions, matching and legacy recipients, empty-region defaults, missing-severity exclusion of low alerts, unsubscribe token retention, and filtered log count.
- `tests/reports-admin-identity.test.ts`: mount the real reports router/auth middleware; assert no-cookie 401, non-admin staff-cookie 403, admin-cookie identity projection/no-store, no unauthorized private-reader calls, and identical stripped public lists with and without admin cookies.
- `tests/components/admin-panel.test.tsx`: add a component regression checking real reporter display, name filtering, `tel:` link, reporter CSV content, and no identity request after a failed session probe. Existing tests remain unchanged apart from the additional test import.

### Fail-without-fix evidence

Kept the new tests in place and temporarily replaced ONLY `server/email.ts`, `server/routes/reports.ts`, and `src/components/AdminPanel.tsx` with their exact `git show 4b543b1:<path>` contents. A Python `finally` block restored the fixed bytes before subsequent lint/build/full-suite validation. No worktree or other clone was modified.

| New regression | Unfixed main result | Fixed result |
| --- | --- | --- |
| MAIL-1 matching recipients, Admin SDK | FAIL: sends 5 recipients, including wrong region and critical-only subscriber, instead of 3 | PASS |
| MAIL-1 matching recipients, client SDK | FAIL: same extra 2 recipients | PASS |
| MAIL-1 missing severity defaults to medium, Admin SDK | FAIL: low alert causes 3 sends instead of 1 | PASS |
| MAIL-1 missing severity defaults to medium, client SDK | FAIL: same 3 sends instead of 1 | PASS |
| ADM-2 route access/projection | FAIL: old route returns 404 instead of the required 401; admin identity endpoint does not exist | PASS |
| ADM-2 component identity consumers | FAIL: cannot find `Amina Reporter (citizen)`; the 3 existing component tests still pass | PASS |

Exact reproduction commands: `npx vitest run --config vitest.server.config.ts tests/email-alert-preferences.test.ts tests/reports-admin-identity.test.ts` (unfixed: exit 1, 5/5 failed; fixed: 5/5 passed) and `npx vitest run --config vitest.config.ts tests/components/admin-panel.test.tsx` (unfixed: exit 1, new test failed / 3 existing passed; fixed: 4/4 passed). Local evidence logs: `/tmp/alert-scope-baseline-server.log` and `/tmp/alert-scope-baseline-component.log`.

### Validation results

- `npm run lint`: PASS, zero diagnostics.
- `npm run build`: PASS, production client/PWA and server bundles generated. Existing Vite `__dirname` / future native-config-loader warning only.
- `npm run test:server`: PASS, 69 files / 667 tests.
- `npm run test:react`: initial run 74 passed files / 1 failed file, 782 passed tests / 1 failed test. The unrelated existing `tests/components/team-panel.test.tsx` phase-update assertion at line 155 failed under the full run; its isolated rerun passed all 30 tests. The complete rerun, `npm run test:react -- --maxWorkers=2`, PASSED: 75 files / 783 tests (exit 0). No test assertions were modified for this retry. Log: `/tmp/alert-scope-react-retry.log`.
- `npm run test:e2e`: attempted with port 3000 verified free; exit 2 before Playwright because Firebase cannot spawn `java -version`. No Java/browser/dependency install attempted.
- `git diff --check`: PASS.

Deviations: no functional scope changes; provider HTTP transport is mocked instead of exporting the private email sender solely for tests. End-to-end verification is limited by the missing Java runtime. No existing tests were weakened and no unrelated finding was changed.

Next: Fix 9 covers `AUD-2` (`server/routes/audit.ts`) and `DB-1` (`server/db.ts`): keep durable audit and report migrations consistent.

## Fix 8b follow-up — CodeRabbit threads on PR #137 (verified, parent-implemented)

Watch 1 on PR #137 (head 9e98fd3) returned DO NOT MERGE with 3 unresolved actionable CodeRabbit threads (review 6001564748, 00:59:42Z), all verified valid by the parent against the code at the head, plus a CI anomaly: no GitHub Actions runs were ever created for the branch (actions/runs total_count 0; only CodeRabbit + Vercel check-runs) — CI cannot be judged green until a push re-triggers it. This follow-up closes all three threads; its push re-triggers CI.

- Thread 1 — Major, Data Integrity (comment 4649483142, `server/email.ts:216`): subscription `wilayas` values were not validated against the canonical region identifiers. The subscribe schema accepted any string (`z.array(z.string().max(100)).max(20)`), stored verbatim; report `wilaya` values are the exact `WILAYA_BOUNDS` labels (`server/geo.ts`), enforced at creation by `wilayaContainsCoords` (exact name match, else 400). The Fix 8 filter compares by exact equality, so a subscriber who saved "Annaba" would never match "الجزائر - عنابة (Algérie - Annaba)" and would silently receive zero alerts for that region — a failure mode the filter itself created (before it, everyone received everything). Fix: `server/geo.ts` now exports `WILAYA_NAMES` (the 22 canonical labels); `server/routes/notifications.ts` validates `wilayas` against it in `subscribeSchema` (`.refine`, unknown values rejected with the existing 400 "Validation failed"). Rejection — not fuzzy normalization — matches report creation's posture and cannot break the bundled client: no in-app caller sends `minSeverity`/`wilayas` to `/api/notifications/subscribe` (verified by grep; the endpoint is called by external clients), and the live region list is the canonical set. The Fix 8 regression fixtures in `tests/email-alert-preferences.test.ts` used "Annaba"/"Algiers" — values no subscriber can save anymore — and are updated to canonical labels. Residual: subscriptions saved before this fix with non-canonical wilayas keep silently matching nothing. CORRECTION (Fix 8c): the original note claimed "they must re-subscribe (the update path re-validates through the same schema)" — that was wrong for verified subscribers, whose re-subscribe returned early ("Subscription already verified.") before any write (verified by the parent against the code at 54b2c82; CodeRabbit review 6001797406). Fix 8c closes the gap both ways: verified subscribers can now update preferences in place, and stored aliases are normalized to canonical labels at send time.
- Thread 2 — Minor (comment 4649483154, `src/components/AdminPanel.tsx:264`): the CSV export button was available while identity requests were pending — the effect fired `void Promise.all(...)` with no loading flag, so an export written mid-flight stored `""` for reporter names and the downloaded file never received the later updates. Fix: `reporterIdentitiesLoading` state, set true at effect start and false in the `Promise.all(...).finally` (guarded by `cancelled`, so a superseded effect cannot clear a newer one's flag); the export button is `disabled={reporterIdentitiesLoading}` with disabled styling.
- Thread 3 — Major, Security & Privacy, CWE-1236 (review body, `src/components/AdminPanel.tsx:264`): reporter names reached the CSV export without formula neutralization — `exportToCSV` only doubled quotes. `reporterName` is citizen-supplied and returned unchanged by the identity endpoint. Fix: `csvCell` in `src/utils/export.ts` is now exported and `exportToCSV` routes every column through it — the same guard `reportsToCsv` uses (leading `= + - @ \t \r` on non-numeric text prefixed with `'`, quote escaping preserved; the ARC-M16 numeric-literal exemption is correct here: AdminPanel exports no numeric columns). NOTE for the #137 merge reconciliation (after PR #135 merges): Fix 6 adds a LOCAL `csvCell` in `AdminPanel.tsx` with slightly different semantics (prefixes `-` on any field, no numeric exemption). The two definitions would collide by name — at reconciliation, drop Fix 6's local definition and keep this shared import; the guards behave identically on AdminPanel's data (no numeric columns), so the switch changes nothing observable.

Files changed (7, +139/−21): `server/geo.ts` (+9, `WILAYA_NAMES` export), `server/routes/notifications.ts` (+15/−1, import + schema refine), `src/utils/export.ts` (+4/−2, `csvCell` exported), `src/components/AdminPanel.tsx` (+30/−12, import, loading state, `csvCell` in `exportToCSV`, disabled button), `tests/email-alert-preferences.test.ts` (fixtures to canonical labels), `tests/notifications.test.ts` (+23, 2 subscribe-contract tests), `tests/components/admin-panel.test.tsx` (+61, 2 tests). Tests: "rejects a subscription with a non-canonical wilaya" (400; on unfixed code the request reaches the DB layer and answers 503) and "accepts a subscription with canonical wilaya labels" (503 with no database — same pattern as the existing unsubscribe tests); "disables the CSV export while reporter identities are loading, then enables it" (identity promise held pending, `waitFor` the disabled button, resolve, enabled); "neutralizes spreadsheet formulas in the CSV export" (reporterName `=2+3`, locationName `@mention`, description `=HYPERLINK(...)` → CSV contains `'=2+3`, `'@mention`, `'=HYPERLINK` and NOT the old `"=2+3"` / `"@mention"` forms). Verification: lint 0 diagnostics; build pass; affected 3 files / 23 passed; full server suite 669 passed (Fix 8 baseline 667 + 2 new); React suite 787 passed (783 + 2 new server tests re-run under jsdom + 2 new admin-panel tests). Fail-without-fix proven by stashing the 4 source files: 3 failed / 20 passed (the 400 test + both admin-panel tests; the canonical-accept test and the 4 email tests pass on unfixed code, as designed — the email fixtures now use values that match on either code).

## Fix 8c follow-up — CodeRabbit thread on PR #137 (verified, parent-implemented)

Re-watch 2 on PR #137 (head 54b2c82, ~01:43Z) returned DO NOT MERGE with two independent blockers: (1) CI still never ran for the PR — 0 GitHub Actions runs across two heads (9e98fd3, 54b2c82) while Actions demonstrably works elsewhere (Fix 9's runs created 01:24:27Z) — so the gate cannot be judged green; (2) one NEW unresolved actionable CodeRabbit Major (comment 4649654167, review 6001797406, `server/routes/notifications.ts:322`): "Stored region aliases stop alerts for verified subscribers, and this endpoint cannot repair them." Both sub-claims were verified by the parent against the code at 54b2c82: (a) `getVerifiedSubscribers` (`server/email.ts:146-151`) returns `doc.data().wilayas` verbatim and the filter compares by exact equality (`email.ts:216`), so a stored "Annaba" never matches a canonical report label; (b) the subscribe handler returns early for verified subscribers in BOTH SDK branches (`notifications.ts:357-360` Admin, `:384-387` client) before any `ref.update`/`updateDoc`, so re-submitting canonical labels writes nothing. The original 3 threads from watch 1 were confirmed SATISFIED in code at the same head. ROOT CAUSE of the CI anomaly (parent finding, ~02:43 CET): the PR is mergeable False (the FIX_PLAN.md EOF-append conflict) — GitHub cannot build the test merge commit, so `pull_request` workflows never run. Same for #135's reconciliation head 8bda817 (0 runs); #135 ran CI fine at ce3169d when it was mergeable, and #138 runs CI because it is mergeable True. Consequence: CI cannot run for #137 until its FIX_PLAN.md conflict is resolved — which happens at merge time, after #135 and #136 merge and the Fix 4/5/6/7 sections are appended. This follow-up closes the CodeRabbit thread; the CI re-trigger follows the conflict resolution, not this push.

- Fix: (i) `server/geo.ts` exports `canonicalizeWilaya` — maps a stored value to its canonical label only on an exact (case-insensitive, trimmed) match against one component of exactly one canonical label (full label, Arabic side, French side, Arabic region, French region); anything else returns unchanged, so unrecognizable aliases keep matching nothing rather than being guessed into the wrong region. (ii) `server/email.ts` `getVerifiedSubscribers` normalizes stored `wilayas` through it in BOTH SDK branches (array only; non-array values pass through). (iii) `server/routes/notifications.ts`: the verified early return becomes a preferences update in BOTH SDK branches — `wilayas`/`minSeverity` (already schema-validated) + `updatedAt` only; `verified` stays true, no new verification/unsubscribe token, no verification email (the email is already verified, so re-verification would be pure friction). The maintainer decision CodeRabbit asked for is therefore: repair in place (verified update path) + normalize at send time (legacy aliases), no migration.
- Residual: a stored alias that matches NO canonical component ("Atlantis") still matches nothing — same as today, no worse; those subscribers must re-subscribe to pick a region.
- NOTE for the #137 merge reconciliation (after PR #135 merges): Fix 6 adds a LOCAL `csvCell` in `AdminPanel.tsx`; the two definitions would collide by name — at reconciliation, drop Fix 6's local definition and keep the shared import (from 8b, unchanged by 8c).

Files changed (7, +249/−20): `server/geo.ts` (+36, `canonicalizeWilaya`), `server/email.ts` (+22/−10, import + normalization in both branches), `server/routes/notifications.ts` (+30/−4, verified repair path in both branches), `tests/geo.test.ts` (+30, 6 `canonicalizeWilaya` tests), `tests/email-alert-preferences.test.ts` (+5/−3, legacy-alias + unknown-alias fixtures), `tests/notifications-subscribe-update.test.ts` (new, 4 tests: verified update + omitted-wilayas reset, Admin + client SDK), `FIX_PLAN.md` (+14, this section + correction of the 8b residual note). Tests: "lets a verified subscriber update preferences without re-verifying" (200, "Subscription preferences updated.", update payload has only the validated preferences + updatedAt, no verified/token keys, no verification email attempted); "omitted wilayas reset a verified subscriber to all regions" (wilayas []); legacy-alias fixture now receives the Annaba alert (recipients 4, count 4) while "Atlantis" receives nothing. Verification: lint 0 diagnostics; build pass; affected 4 files / 42 passed; full server suite 679 passed (8b baseline 669 + 10 new); React suite 797 passed (787 + 10 new — the new `.test.ts` files re-run under jsdom). Fail-without-fix proven by stashing the 3 source files: 12 failed / 17 passed (6 geo + 2 email + 4 subscribe-update, exactly as designed).

Next: Fix 10 covers `ATM-2` (`server/atomic.ts`) and `FS-1` (`server/fs.ts`): invalidate server document and collection caches.

## Fix 8d follow-up — web-editor conflict resolution mangled one line (verified, parent-implemented)

After #136 merged (main 02bf591), the #137 branch's FIX_PLAN.md was reconciled by script (594 + Fix 8/8b/8c sections = 657 lines) and pushed as b2768d9. The web-editor conflict resolution (merge commit 56170fd, parents b2768d9 + 02bf591) kept the branch side in both conflicted files as instructed — but it MANGLED one line of `src/components/AdminPanel.tsx` at the resolution boundary: the 8b declaration `const [reporterIdentitiesLoading, setReporterIdentitiesLoading] = useState(false);` became `const [\n    , setReporterIdentitiesLoading] = useState(false);` — the variable was dropped while the export button still reads it (`disabled={reporterIdentitiesLoading}`, :440). The parent caught it by byte-comparing the tip against the pre-merge file; it is a real break, not cosmetic.

- Fix: restore the declaration to its single-line form (1 file, +1/−2). Nothing else in the file changed — the setter calls and the disabled prop are untouched.
- Verification: lint 0 diagnostics; build pass; `tests/components/admin-panel.test.tsx` 6/6 passed. Fail-without-fix proven by stashing the fix: `tsc` fails with exactly `error TS2552: Cannot find name 'reporterIdentitiesLoading'. Did you mean 'setReporterIdentitiesLoading'?` at AdminPanel.tsx:440. Lesson: after every web-editor conflict resolution, byte-compare BOTH resolved files against the intended versions before trusting the merge commit — the editor can silently damage lines adjacent to the conflict hunks.

## Fix 8e follow-up — re-watch blockers on PR #137 (verified, parent-implemented)

Re-watch on PR #137 (head 3a3bd13, ~09:30 CET) returned DO NOT MERGE with two independent blockers, and the parent's own full-suite run on the merged tree found a third. All three are fixed here. This is also the FIRST CI run ever for #137 — the conflict theory holds: three `pull_request` runs were created at 07:59:35Z for the 8d head, after zero runs across all earlier heads while mergeable False.

- Blocker 1 — lint-and-test fails on `tests/reports-admin-identity.test.ts:62` (`expected 401 to be 403`): a genuine Fix 4 × Fix 8 merge interaction, reproduced locally. The test mounts the real reports router with `getDb: () => null` and a staff token carrying `agentId`; Fix 4 made staff sessions fail closed when the revocation register cannot be read (`requireAuth` 401s before `requireAdmin`'s 403 is ever reached). The route contract (authenticated non-admin → 403) still holds with a live DB. Fix (test only): the 403 leg now uses an agentId-less staff token (`generateStaffToken({ role: "agent" })`), which reaches the role gate under a null DB; the agentId staff path is covered by the middleware tests.
- Blocker 2 — NEW CodeRabbit Major, CWE-862 (comment 4649844534, review 6002033438, on the 8c head, never addressed): "Unauthenticated requests can change a verified subscriber's alert preferences." Verified against the code: `POST /subscribe` has no auth, and the 8c verified-update path wrote the supplied `wilayas`/`minSeverity` in BOTH SDK branches — anyone who knew a verified subscriber's email could set `minSeverity: "critical"` and suppress their alerts. Fix: the verified-update path now requires the stored `unsubscribeToken` as proof of mailbox control — the same 64-hex token the `/unsubscribe` endpoint already checks, delivered to the mailbox in the verification email and in every alert email's unsubscribe link; missing or wrong token → 403 "Invalid unsubscribe token" in BOTH SDK branches. New and unverified subscriptions are unchanged: mailbox control there is proven by the verification email (the unverified path re-issues a fresh verification token + expiry + unsubscribe token and keeps `verified` false). No in-app caller posts to `/subscribe`, so requiring the token breaks no UI flow. Maintainer decision: reuse the existing unsubscribe-token proof rather than a new confirmation round-trip.
- Blocker 3 (parent finding) — 9 tests in `tests/components/operator-exports-authority.test.tsx` (Fix 6, ADM-1) failed on the merged tree: the 8b shared `csvCell` differed from Fix 6's local guard in two ways — it checked the formula trigger only at position 0 (no leading-whitespace handling, so `"  =1+1"` passed through) and it had no force-quote parameter (Fix 6 force-quoted the four text columns). The 8b note claiming identical behaviour on AdminPanel's data was wrong for these cases. Fix: the shared `csvCell` now takes `quoted = false`, checks the trigger after optional leading whitespace (`/^\s*[=+\-@\t\r]/`, keeping the ARC-M16 numeric exemption — pure numeric literals still pass through), and AdminPanel passes `quoted=true` for locationName, wilaya, description, reporterName. `reportsToCsv` calls it as `.map((v) => csvCell(v))` (the bare `.map(csvCell)` became a type error once the second parameter existed). A second, subtler failure was a test race the 8b identity feature introduced: the stubbed identity fetch returned `{}` for every URL, so if it resolved before the export click the merge wiped the prop's reporterName to `""`; the test's fetch stub now returns the malicious name only for the malicious report's own identity URL (id-matched after `decodeURIComponent`) and `{}` for the ordinary row — the value is the same through either order, so the test is deterministic (33/33 in 6 consecutive runs after 1–2 failures per run before).

Files changed (7, +164/−12): `server/routes/notifications.ts` (+28/−2, optional `token` in the subscribe schema + the 403 gate in both verified branches), `src/utils/export.ts` (+15/−2, `quoted` param + whitespace-aware trigger), `src/components/AdminPanel.tsx` (+16/−2, per-column quoting in exportToCSV), `tests/notifications-subscribe-update.test.ts` (+79, 3 new 8e tests × 2 SDKs + token on the 8c tests), `tests/reports-admin-identity.test.ts` (+8/−1, agentId-less staff token + comment), `tests/components/operator-exports-authority.test.tsx` (+20/−1, identity-aware fetch stub + comment), `FIX_PLAN.md` (+10, this section). Tests: 6 new 8e tests (verified update with no token → 403, with the wrong token → 403, unverified re-subscribe with no token → verification flow, each in both SDKs). Verification: lint 0 diagnostics; build pass; affected 6 files / 69 passed; full server suite 713 passed (merged-tree baseline 707 + 6 new, 0 failed — the baseline itself had the 1 identity-test failure this fix closes); full React suite 864 passed (0 failed). Fail-without-fix proven: stashing only `server/routes/notifications.ts` fails exactly the 4 new rejection tests (6 passed); stashing only `src/utils/export.ts` + `src/components/AdminPanel.tsx` fails exactly the 9 operator-export neutralization tests (24 passed).
## Fix 9 validation — AUD-2 / DB-1

Base: `4b543b1257b29534dd0b50099a6e2e736d18e47b` (local main, PR #132). Created `fix/wildfire-9-audit-migration` directly from main, not the existing Fix 8 branch (`ca568e1`). Fetch succeeded; origin/main advanced to `5e579cb`, but the explicitly requested base remains `4b543b1`. No other fix branch is an ancestor. No dependencies installed; no other clone or worktree modified. No push, PR, or merge.

### Changes

- `server/routes/audit.ts`: one shared in-flight flush promise serializes queue recovery and lets concurrent callers join the drain. Retains stop-at-first-failure, the 500-entry newest-kept cap, and the 60-second sweeper. Remove only the entry actually persisted, so a concurrent cap eviction cannot cause removal of the next entry. A log joining a drain still persists its own entry afterwards.
- `server/db.ts`: migrate legacy reports inside one Admin SDK transaction. Re-read the public row and abort without any writes if missing or if any stored field differs from the snapshot used to derive the migration. `isDeepStrictEqual` compares the complete document, covering status, severity, identity, images, and other overwritten fields; the report has no per-mutation version timestamp. Stage public/private/image writes together; Firestore's transaction read conflict handling protects changes between the re-read and commit. Keep catch-and-warn and retry on subsequent uncached reads. Confirmed the client SDK read path only scrubs fields and does not trigger a migration. Serializer, wire cache, moderation, and purge logic unchanged.
- `tests/audit-durability.test.ts`: two new regressions use controllable persistence gates: concurrent [A,B] drain with B failing and later succeeding exactly once, plus a new log joining an older queued drain without duplicate persistence or deadlock.
- `tests/report-migration-race.test.ts`: six new regressions with snapshot-capture hooks and staged transaction writes. Cover deletion, verification, resolution, severity correction, identity correction, and transaction failure. Assert no writes/shards on stale or failed migration; changed rows migrate on a fresh read while preserving changes; an untouched row migrates completely after failure recovery.
- `tests/privacy-split.test.ts`: extend the existing fake transaction with `set`, required by transactional migration. Existing assertions unchanged.
- `FIX_PLAN.md`: this evidence and handoff.

### Fail-without-fix proof

Kept all new tests and the compatible fake transaction in place, temporarily replaced ONLY `server/routes/audit.ts` and `server/db.ts` with exact `git show 4b543b1:<path>` bytes, then restored fixed bytes in a Python `finally` block. Ran the same command on both implementations:

`npx vitest run --config vitest.server.config.ts tests/audit-durability.test.ts tests/report-migration-race.test.ts tests/privacy-split.test.ts`

Unfixed: exit 1, **8 failed / 18 passed** (3 files: 2 failed, 1 passed). Fixed: exit 0, **26/26 passed** (3 files). Logs: `/tmp/fix9-baseline.log`, `/tmp/fix9-affected.log`. Per-regression evidence:

| New regression | Exact unfixed failure | Fixed |
| --- | --- | --- |
| AUD-2 concurrent [A,B], B fails | Retry flush returns 0 instead of 1: B was lost; concurrent drain duplicated A | PASS: attempts [A,B], retry writes only B, subsequent flush empty |
| AUD-2 log joins older drain | Attempts [joined.old, joined.old, joined.new], duplicating old entry | PASS: [joined.old, joined.new] |
| DB-1 deleted after snapshot | Writes reportPrivate/legacy, reportImages/legacy, reports/legacy instead of no writes | PASS: no row or shards recreated |
| DB-1 verified after snapshot | Same three unconditional writes | PASS: abort; next fresh migration retains verified |
| DB-1 resolved after snapshot | Same three unconditional writes | PASS: abort; next fresh migration retains resolved |
| DB-1 severity changed after snapshot | Same three unconditional writes | PASS: abort; next fresh migration retains critical severity |
| DB-1 identity changed after snapshot | Same three unconditional writes | PASS: abort; next fresh migration retains corrected identity |
| DB-1 transaction failure / untouched retry | Same three unconditional writes despite failed transaction backend | PASS: no partial writes, later untouched migration writes all three shards |

### Validation

- Affected suites: PASS, 3 files / 26 tests; includes all 8 new regressions and all 18 existing tests unchanged. Log `/tmp/fix9-affected.log`.
- `npm run lint`: PASS, zero diagnostics (exit 0). Log `/tmp/fix9-lint.log`.
- `npm run build`: PASS, production Vite/PWA and server bundles (exit 0). Existing Vite `__dirname` / future config loader warning only. Log `/tmp/fix9-build.log`.
- `npm run test:server`: PASS, 68 files / 670 tests (exit 0). Log `/tmp/fix9-server.log`.
- `npm run test:react -- --maxWorkers=2`: PASS, 74 files / 785 tests (exit 0). Log `/tmp/fix9-react.log`.
- `npm run test:e2e`: attempted after verifying port 3000 free; exit 2 before Playwright: `Could not spawn java -version`. No Java/browser/dependency installation attempted. Log `/tmp/fix9-e2e.log`.
- `git diff --check`: PASS.

Deviations: none in functional scope. Tests use an in-memory staged transaction mock, not live Firestore; SDK contention/retry semantics are supplied by Firestore and are not integration-tested here. End-to-end verification is limited by missing Java. Sandbox approval checks delayed writes but all requested local edits and checks completed.

Next: **Fix 10** — `ATM-2` (`server/atomic.ts`) and `FS-1` (`server/fs.ts`): invalidate server document and collection caches (triage rows 139–140).
## Fix 10 — ATM-2 + FS-1

Branch `fix/wildfire-10-cache-invalidation` starts at main `01b6179`.

- `server/fs.ts` evicts all order/limit variants matching the collection key prefix. The key format, TTLs and document invalidator are unchanged.
- `server/atomic.ts` invalidates the documents and collections written by all ten atomic writers after the transaction resolves successfully, in both SDK paths. Idempotent block and unblock results retain their public return values and skip eviction.
- `tests/cache-invalidation.test.ts` exercises the real cache against staged in-memory Firestore transactions for both SDKs. Two additional controls verify that no-write outcomes and a failed commit preserve cached reads.

Each source file was temporarily replaced with its exact main version in isolation and then restored. `npm run test:server -- tests/cache-invalidation.test.ts -t FS-1` exited 1 with 2 failures. The analogous `-t ATM-2` run exited 1 with 22 failures. Each row below failed in both SDK paths and passed with the fix.

| Regression | Unfixed result |
| --- | --- |
| FS-1 collection query variants | Read value 1 after committing value 2 |
| ATM-2 new roster day | Returned cached null |
| ATM-2 existing roster day | Returned the previous posts |
| ATM-2 unit creation | Returned cached null after the unit precheck |
| ATM-2 staff creation | Returned cached null for the new user |
| ATM-2 unit deletion | Returned the deleted unit |
| ATM-2 registration and uniqueness reservations | Returned cached null for the new registration |
| ATM-2 approval and badge | Returned pending instead of approved |
| ATM-2 team join | Returned the previous code budget |
| ATM-2 mission phase | Returned en_route instead of on_scene |
| ATM-2 mission clear | Returned en_route instead of cleared |
| ATM-2 principal block and unblock | Returned the previous blocklist |

Logs are in `/tmp/fix10-unfixed-fs.log` and `/tmp/fix10-unfixed-atomic.log`.

- Targeted regressions passed, 26/26 (`/tmp/fix10-affected.log`).
- `npm run lint` passed (`/tmp/fix10-lint.log`).
- `npm run build` passed (`/tmp/fix10-build.log`).
- Full server suite passed, 716 tests in 72 files (`/tmp/fix10-server-final.log`).
- Full React suite passed, 831 tests in 78 files with `--maxWorkers=2` (`/tmp/fix10-react-final.log`).
- End-to-end execution stopped before Playwright. Port 3000 was free, but the Firestore emulator could not spawn `java -version` (`/tmp/fix10-e2e.log`).
- `git diff --check` passed.

`tests/seed-staff.test.ts` supplies the two cache invalidator exports in its existing Firestore helper mock. The assertions are unchanged. No other functional changes outside ATM-2 and FS-1.

Next is **Fix 11** (triage rows 141–142). ATM-1 aligns the unit identity used by the linked-staff deletion guard. SEED-1 makes staff bootstrap report persistence failures and exit unsuccessfully.

## Fix 10b follow-up — CodeRabbit thread on PR #139 (verified, parent-implemented)

Watch 1 on PR #139 (head d3535eb) returned DO NOT MERGE with one unresolved actionable CodeRabbit thread (Minor, Data Integrity & Integration): "Prevent pending reads from restoring invalidated data" (`server/fs.ts:31–33`). The coordinator verified it valid against the code, and the parent re-verified it from the source: `collectionGet` awaits the Firestore read after a cache miss (`fs.ts:62` Admin / `:74` client) and then unconditionally re-caches (`:88`); a writer committing and invalidating in that window has its invalidation silently undone for up to the 30s TTL. The same hole exists in `docGet` (`:113`/`:119` read, `:127` unconditional set, 60s TTL), which CodeRabbit did not flag — a complete fix covers both. Everything else in the gate passed (own checks green, Analyze both green, CodeQL neutral 0 annotations with alert #20 held, instrumented the known emulator boot timeout).

- Fix: `server/fs.ts` gains a per-collection generation map (`cacheGenerations`, keyed by collection name — bounded key space, no leak). Both invalidators bump their collection's generation FIRST, even when nothing is cached (a read may be pending in flight); `invalidateDocCache` bumps its collection's generation too, so a pending collection read of the same collection cannot re-cache either. Both getters capture the generation before the read and cache only when it is unchanged afterwards. The data is still returned to the pending caller — it is merely not stored for the next one. A stale generation value can only make a read skip caching, never serve stale data. The design follows CodeRabbit's suggested fix (generation counter, cache only if unchanged) and adds the doc side CodeRabbit left out.
- Tests: the mock backend in `tests/cache-invalidation.test.ts` gains a `readGate` — reads take their snapshot BEFORE awaiting the gate, modelling a read that executed pre-write but whose response arrives post-invalidation (awaiting first would read post-write data and never exercise the race). Two new tests per SDK (collection + doc): start a gated read, write + invalidate while it is pending (asserting `reads === 1` proves the read is genuinely in flight), release, assert the pending call returns its pre-write snapshot and the NEXT read returns the new value. The gate defaults to null, so the 26 existing tests are untouched.

Files changed (3, +90/−7): `server/fs.ts` (+34/−4, generation map + bumps + guarded sets), `tests/cache-invalidation.test.ts` (+46/−3, `readGate` in the mock + 4 tests), `FIX_PLAN.md` (+10, this section). Verification: lint 0 diagnostics; build pass; affected 2 files / 34 passed (30 cache-invalidation + 4 seed-staff); full server suite 720 passed (Fix 10 baseline 716 + 4 new); React suite 835 passed (831 + 4 — the new `.test.ts` files re-run under jsdom). Fail-without-fix proven by stashing `server/fs.ts`: 4 failed / 26 passed — exactly the 4 new 10b tests, both SDKs.

## Fix 12 — AIG-1 / AIG-2 / SZM-2 / SAT-1: dataset outages versus current observations

Branch: `fix/wildfire-12-dataset-outages`, based directly on main `b580dfc518e792611419e3c6826a3c6e501d775f` after fetching origin. The clone initially contained a clean Fix 11 branch; that branch was left intact and none of its changes were used. Fix 11/11b is outside this change. No dependency installation, client change, push, PR, or merge.

### Files and contracts

- `server/routes/ai.ts` (AIG-1): use the existing discriminated `getReportsDbResult` instead of the lossy nullable wrapper. `error`, `no-db`, rejected reads, and the existing three-second context deadline return **503 `{error: "Report context is currently unavailable"}`**, without `guidance` and before invoking AI. Clear the deadline timer after completion. A confirmed `empty` read remains successful. This follows the existing safe-zone/reports unavailable contract and distinguishes unknown conditions from zero observed nearby reports.
- `server/routes/ai.ts` (AIG-2): reuse `isFreshThreatTimestamp` from `server/routes/wilayas.ts`, including its existing **30-minute maximum age / two-minute future-skew allowance**. Invalid timestamps also fail that predicate. Apply it before both fallback counts and provider prompt construction. Keep resolved/rejected and distance exclusions unchanged; retain fresh critical guidance and successful provider responses.
- `server/routes/safezones.ts` (SZM-2): preserve the successful array body and 60-second route TTL. Record the successful load time. A failed refresh may serve cached active centres only through **five minutes from the last successful load** (five existing route TTLs; no existing safe-zone maximum-stale convention was present). Such a response carries **`X-Data-Stale: true` and `X-Data-Updated-At: <ISO last-load time>`**. After that absolute age, return the existing **503 `{error}`** instead of the list. Failed refreshes never renew its age. Internal PUT/DELETE consumers access the same list through the load result's `data` field.
- `server/routes/satellite.ts` (SAT-1): source reads distinguish `ok` (including empty feeds) from `unavailable` (missing key, non-OK HTTP, transport error, abort). If **either source fails**, GET returns **503 `{error: "Satellite data is currently unavailable", sources: {VIIRS_SNPP_NRT: "ok" | "unavailable", MODIS_NRT: "ok" | "unavailable"}}`**. This conservative partial-outage contract lets the existing client retain its previous dataset rather than commit an incomplete list as healthy. Only complete successful observations use the existing array contract and populate the existing nonempty cache. Deduplication, healthy cache lifetime, and healthy empty responses are unchanged; SAT-2 empty caching/coalescing is not included. The shared `getLiveSatelliteData` helper throws the typed outage error rather than claiming empty success; wilayas already catches it, while history follows its existing Express error path.
- `tests/dataset-outages.test.ts`: real Express route handlers, with only backend/configuration boundaries mocked, plus a controlled clock for cache-age checks. No live DB or HTTP. 14 regression cases and three healthy-path controls (17 cases total).
- `tests/ai.test.ts`, `tests/ai-failures.test.ts`: supply a confirmed-empty DB fixture so the existing provider/fallback tests continue exercising their intended healthy-context paths. Existing assertions and timeout checks are unchanged.
- `tests/history.test.ts`: supply a healthy HTTP feed and test FIRMS key for the existing successful history bucket tests, retaining the real satellite/history handlers and every assertion. Previously these tests implicitly relied on a missing production key being treated as a healthy empty sky.
- `FIX_PLAN.md`: this implementation, contract, verification, and proof record.

### Fail-without-fix evidence

The new route test file was first executed **before any production-route changes**, on the specified main baseline: `npm run test:server -- tests/dataset-outages.test.ts`. Result: **13 failed / three healthy controls passed**, in `/tmp/fix12-unfixed.log`. Each failure was a behavior assertion against the actual route, not a fixture/import failure. The tests expose both old and new DB boundary names solely so the same fixtures exercise the original and corrected route implementations.

| Finding / regression case | Observed on unfixed main |
| --- | --- |
| AIG-1: DB result `error` | Expected 503, received 200/all-clear |
| AIG-1: `no-db` | Expected 503, received 200/all-clear |
| AIG-1: hanging DB / three-second context timeout | Expected 503, received 200/all-clear |
| AIG-1: rejected DB read | Expected 503, received 200/all-clear |
| AIG-2: 90-day-old pending critical report, fallback + prompt | Critical fallback instead of zero-current-report fallback; failed `Aucun foyer` assertion |
| AIG-2: ten-minute-future pending critical report, fallback + prompt | Same incorrect critical fallback |
| AIG-2: invalid-timestamp pending critical report, fallback + prompt | Same incorrect critical fallback |
| SZM-2: within-age refresh failure must be marked stale | Expected `X-Data-Stale: true`, received no header |
| SAT-1: both HTTP sources fail | Expected 503, received 200 `[]` |
| SAT-1: both transports reject | Expected 503, received 200 `[]` |
| SAT-1: both requests abort on the route's actual 15-second source deadlines | Expected 503, received 200 `[]` |
| SAT-1: missing direct-FIRMS key | Expected 503, received 200 `[]` |
| SAT-1: one HTTP source fails, the other supplies detections | Expected 503 with per-source statuses, received 200 |

A separate SZM-2 expiry regression was then added so the earlier missing-header assertion cannot mask the age-limit defect. Saved the fixed safe-zone route to `/tmp/fix12-route-backup/safezones.ts`, temporarily replaced only that route with `git show HEAD:server/routes/safezones.ts`, ran `npm run test:server -- tests/dataset-outages.test.ts -t 'absolute age bound'`, and restored the fixed file. **One failed / 16 skipped**: after refresh failures at 120 seconds and 300.001 seconds from the successful load, expected 503 but received 200. Evidence: `/tmp/fix12-unfixed-expiry.log`.

Resumed-session independent re-verification: temporarily replaced all three route files with `git show HEAD:<path>` at the exact `b580dfc518e792611419e3c6826a3c6e501d775f` baseline, ran the complete final `tests/dataset-outages.test.ts`, and restored every fixed file in a Python `finally` block. **14 failed / three healthy controls passed (17 tests)**, all expected behavior failures, including the independent absolute-age regression. Evidence: `/tmp/fix12-unfixed-reverified.log`.

The AIG-2 tests also assert the provider prompt contains `Active reports: 0, High/Critical: 0` after each aged/invalid fixture. Healthy controls intentionally pass on both versions: confirmed-empty context succeeds, fresh critical reports still count while resolved/rejected reports do not, and two healthy empty FIRMS feeds return 200 `[]`.

### Verification

- Affected routes/tests: **34/34 passed**, four files (`/tmp/fix12-affected.log`).
- `npm run lint`: passed (`/tmp/fix12-lint.log`).
- `npm run build`: passed, Vite and bundled server (`/tmp/fix12-build.log`).
- Final `npm run test:server`: **768/768 passed**, 77 files (`/tmp/fix12-server.log`), including all **17/17** new route cases and the existing AI/history cases.
- Final `npm run test:react`: **919/919 passed**, 84 files (`/tmp/fix12-react.log`), including the same route regressions under jsdom.
- `npm run test:e2e`: attempted twice; **environment blocked before Playwright starts** (exit 2): Firebase cannot spawn `java -version` because Java is absent (`/tmp/fix12-e2e.log`). No packages were installed and no unrelated processes were stopped.
- Initial full-server validation exposed five history success tests that depended on absent FIRMS credentials returning `[]`. Updated only their HTTP/config fixtures as described above; no assertions were removed or weakened. The final full suites are green.
- `git diff --check`: passed. No production-scope deviations; no client changes, dependency changes, push, PR, or merge. Local branch is based directly on the requested main commit; Fix 11/11b is not included.

Next: **Fix 13 — SOS-4 (`server/routes/sos.ts`, report line 620) and FS-2 (`server/fs.ts`, report line 711)** per triage rows 147–148.

## Fix 12b follow-up — history endpoint must survive a satellite outage (parent-implemented)

Fix 12's SAT-1 made `getLiveSatelliteData` throw `SatelliteUnavailableError` on any source outage. `wilayas.ts` already catches it (falls back to empty hotspots with a warning log), but `server/routes/history.ts:63` called it uncaught — so in production without a FIRMS key, or during a FIRMS outage, `GET /api/history` would return 500 via the global error handler instead of 200 with hotspots 0. That turns a partial degradation into a total failure of the history endpoint, beyond SAT-1's scope (which was about `GET /api/satellite` itself).

Files changed (3, +32/−3): `server/routes/satellite.ts` (+1/−1, `SatelliteUnavailableError` is now exported), `server/routes/history.ts` (+19/−2, the satellite call is wrapped in try/catch for `SatelliteUnavailableError` only — anything else still throws; on catch it logs a warning and the response carries `hotspotsUnavailable: true` with hotspots 0; the field is omitted on healthy responses), `tests/history.test.ts` (+12, 1 new test: both FIRMS sources returning 500 → history returns 200 with 7 buckets, `hotspotsUnavailable: true`, all hotspots 0).

Verification: lint 0 diagnostics; build pass; affected 2 files / 23 passed (history 6 + dataset-outages 17). Fail-without-fix proven by stashing only `server/routes/history.ts`: exactly the 1 new test failed / 5 passed. Full suites on this branch tree: server 77 files / 769 passed, React 84 files / 920 passed, 0 failed (both RC=0; the +1 per suite vs Fix 12 alone is the new history test).
