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
