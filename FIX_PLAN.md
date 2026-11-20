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
