# Architecture Roadmap — Provenance/Trust Domain Model & ThreatObservation Route Engine

**Status:** DESIGN PHASE (per the external audit's explicit scoping — this document is the deliverable; no production code rides with it).
**Version target:** v2.17.0 train (design sign-off → implementation PRs).
**Inputs:** the 7,867-line external audit (server + Android), the v2.15.0 remediation waves 1–2, the v2.16.0 wave 3 (this train), and the operational constraints documented in `docs/RUNTIME_BASELINE.md`.

---

## 1. Why a design phase (and not code)

The audit's architecture section asks for two structural capabilities — a **provenance/trust domain model** and a **ThreatObservation route engine** — that cut across the server's report pipeline, the web client's threat display, and the Android radar/route stack. Landing them as ad-hoc patches to v2.15/2.16-era code would entrench the very implicitness the audit criticizes: today, trust is *encoded in field names* (`verified`, `communityConfirmed`, `origin: "mesh"`) and *scattered across handlers* (report admission, mesh relay attenuation, badge verification, the web's freshness window). A domain model has to be *designed once* so all three platforms derive their behavior from one contract, the same way `isFreshThreatTimestamp` (web) and `TelemetryCamera.THREAT_MAX_AGE_MS` (Android) already share one freshness contract.

---

## 2. Current state (what v2.15.0/v2.16.0 already enforce)

| Trust concern | Current enforcement | Remaining gap |
|---|---|---|
| Mesh gossip honesty | Hub strips `status/consensusCount/verified` from relayed `report:new`; clients admit gossip as pending+mesh origin only | Provenance is a *tag on a report row*, not a queryable ledger |
| Consensus integrity | Anonymous confirmations → `communityConfirmed` (never `verified`); re-vote shift() fixed | No observation *history* — a report's trust journey is overwritten, not accumulated |
| Verified status | Badge/operator-gated server-side; alert pipeline gated on trusted verification | `verified` is boolean — no strength/decay dimension |
| Identity | Device pseudonyms + principal cookie; superadmin separation | Ephemeral mesh keys are privacy-first by design — no binding to a device identity yet |
| Route selection | RadarV2 safety-first alternatives (clearance + road class), NaN-hardened | Single-shot: one OSRM call per SOS — no observation-informed corridor model |

---

## 3. Provenance / Trust domain model (design)

### 3.1 Core principle

**A threat's trust level is a derived fact, not a stored flag.** Stored: the *observations* (who reported/confirmed what, when, through which channel, with what identity strength). Derived: `effectiveTrust(t)` computed from the observation set by a pure function — testable on JVM, Node and (later) Dart from one specification.

### 3.2 Domain types (single source of truth: this section)

```text
ProvenanceEvent {
  id: UUID                 // server-minted, immutable
  threatId: UUID           // the report/SOS the event attaches to
  kind: REPORT | CONFIRM | VERIFY | RETRACT | BADGE_BIND
  channel: API | MESH_RELAY | OPERATOR | FIRMS_PASS
  actor: ActorRef          // principal-cookie id | mesh ephemeral id (rotating) | badge id | satellite pass id
  identityStrength: ANONYMOUS(0) | DEVICE_PSEUDONYM(1) | BADGE_HOLDER(2) | OPERATOR(3)
  atMs: server timestamp   // client timestamps are data, never authority
  payloadDigest: sha256    // binds the event to exactly what was claimed
}

EffectiveTrust {
  level: PENDING | COMMUNITY_CONFIRMED | VERIFIED
  strength: 0..100         // derived, monotone in identityStrength & recency
  computedAtMs
}
```

### 3.3 Derivation rules (v1 — deliberately simple)

1. `strength = Σ over distinct actors (identityStrength weight)` — distinctness keyed on actor id, so mesh key rotation cannot re-vote (the audit's voter-shift finding stays dead).
2. Level mapping: any OPERATOR or BADGE_HOLDER VERIFY → `VERIFIED`; strength ≥ 5 with only ANONYMOUS/DEVICE_PSEUDONYM confirmations → `COMMUNITY_CONFIRMED`; else `PENDING`. (Preserves today's Sybil-honest behavior — v2.15.0 wave 1 — as a theorem, not a convention.)
3. Trust never *decays* in v1; recency enters via the existing freshness window at display time. Decay is a v2 concern (needs owner decision on what "stale verified fire" means operationally).
4. The events table is append-only; a retraction is an event, never a deletion (audit-trail doctrine already used for team removal).

### 3.4 Storage & rollout

- Firestore: `threats/{id}/provenance/{eventId}` subcollection — append-only, rules: write only via server (Admin SDK), read via existing report reads.
- The `reports` doc keeps its current fields (zero client breakage); `effectiveTrust` is materialized by the same transaction that appends events.
- Rollout: server derives + emits `effectiveTrust` alongside today's fields; web/Android switch renderers to it; only then do the legacy flag flips become server-internal.

---

## 4. ThreatObservation route engine (design)

### 4.1 Core principle

**Routes are scored against observations, not snapshots.** Today RadarV2 scores candidate roads against the *current* fire set (hotspots + verified reports). The engine generalizes the input to a normalized **ThreatObservation** stream so route scoring, the risk gauge and the map spread-cone all consume the same table.

### 4.2 Domain types

```text
ThreatObservation {
  id: UUID
  source: FIRMS_PASS | CITIZEN_REPORT | MESH_INTEL | WEATHER_DERIVED
  geometry: center(lat,lng) + radiusKm (source-class default: FIRMS 1km,
             citizen 0.5km, mesh 1.5km — honesty margin for coarse grants,
             see v2.16.0 LocationEngine tiers)
  confidence: 0..1         // from EffectiveTrust.strength for citizen/mesh;
                           // 0.95 for FIRMS passes, 0.3 for weather spread
  observedAtMs, expiresAtMs // FIRMS: next-pass horizon; mesh: TTL 10min;
                            // citizen: the 30-min freshness window
  shadowOf?: threatId      // dedup: a mesh echo of a known report shadows it
}

RouteScore {
  path: polyline           // from OSRM (alternatives already wired)
  minClearanceKm           // min distance to any live observation
  exposureKm               // length within radius of any live observation
  roadClass                // from OSRM annotations
  score                    // v1: safety-first lexicographic (clearance,
                           // exposure, class) — identical ranking doctrine
                           // RadarV2 already ships
}
```

### 4.3 Engine responsibilities (v1)

1. **Ingest**: FIRMS passes (existing proxy cadence), reports (server), mesh intel (relay-attenuated, v2.15.0 rules), weather spread cone (wind-derived polygon → sampled observations).
2. **Dedup/shadow**: mesh intel that echoes an already-known report becomes a *confidence observation on that threat* rather than a new blip (removes the double-counting the audit noted between radar and map).
3. **Score**: for each OSRM alternative, walk the polyline against the live observation set (spatial grid, same bounding-rectangle primitives `GeoMath` already ships) → `RouteScore[]`.
4. **Serve**: `/api/route-score` (server-computed, cache 30s) + an identical pure-Dart/Kotlin re-implementation offline (mesh-only field conditions) — same spec, three runtimes, one test vector file.

### 4.4 Non-goals (v1)

- No dynamic re-routing mid-navigation (Google Maps deep-link remains the nav surface — owner decision, M34-36 session).
- No fire-spread *simulation* (weather cone is a heuristic band, clearly labeled "reference-only" as the UI already does).
- No routing through private/unmapped tracks (OSRM driving profile only).

---

## 5. Phasing (each phase = own PR train, green-gate protocol)

| Phase | Scope | Platform touch | Risk |
|---|---|---|---|
| **2a** | Domain types + derivation spec as pure modules + shared test vectors (TS + Kotlin, JVM-tested both sides) | server (new module), android (new pure file) | Low — additive |
| **2b** | Provenance ledger write path (append events in report/confirm/verify/badge transactions) + `effectiveTrust` materialization + Firestore rules | server, firestore.rules | Medium — transactional |
| **2c** | Renderers consume `effectiveTrust` (web chips, Android radar kinds) | web, android | Low |
| **2d** | ThreatObservation ingest + dedup/shadow + `/api/route-score` | server | Medium |
| **2e** | RadarV2/map consume RouteScore; offline pure-Dart twin for the Flutter client | android, (flutter) | Medium |

Gate between phases: the audit's own criteria — no behavior change visible to a field user unless the phase's spec says so; every derivation rule pinned by cross-platform identical test vectors.

---

## 6. Open decisions for the owner (blockers for 2a sign-off)

1. **Trust decay** — should `VERIFIED` near a 10-min-stale fix downgrade at display time? (SOS dispatch UX impact.)
2. **Mesh identity binding** — bind ephemeral mesh keys to the device identity at handshake (CryptoEngine's stated future purpose) — yes/no? Privacy trade documented in CryptoEngine kdoc (correlation across rotation windows).
3. **FIRMS pass horizon** — accept the next-pass estimate (2–6h) as `expiresAtMs`, or keep observations alive until the *next* pass contradicts them?
4. **Route-score hosting** — server-computed (needs Render CPU) vs on-device only (works offline, slower). v1 leans on-device with server as optional accelerator.
