import { describe, it, expect } from "vitest";
import { wilayaMatches } from "../server/routes/wilayas.js";

const EL_TARF = { nameAr: "الجزائر - الطارف", nameFr: "Algérie - El Tarf" };
const TIZI = { nameAr: "الجزائر - تيزي وزو", nameFr: "Algérie - Tizi Ouzou" };
const JIJEL = { nameAr: "الجزائر - جيجل", nameFr: "Algérie - Jijel" };

describe("wilayaMatches", () => {
  it("matches exact French name", () => {
    expect(wilayaMatches("El Tarf", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(true);
  });

  it("matches exact Arabic name", () => {
    expect(wilayaMatches("الطارف", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(true);
  });

  it("matches with wilaya prefix", () => {
    expect(wilayaMatches("ولاية الطارف", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(true);
    expect(wilayaMatches("Wilaya d'El Tarf", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(true);
  });

  it("matches satellite label format", () => {
    expect(
      wilayaMatches("الجزائر - تيزي وزو (Algérie - Tizi Ouzou)", TIZI.nameAr, TIZI.nameFr)
    ).toBe(true);
  });

  it("does not match wrong wilaya", () => {
    expect(wilayaMatches("Jijel", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(false);
    expect(wilayaMatches("جيجل", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(false);
    expect(wilayaMatches("Tizi Ouzou", JIJEL.nameAr, JIJEL.nameFr)).toBe(false);
  });

  it("handles empty or gibberish input", () => {
    expect(wilayaMatches("", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(false);
    expect(wilayaMatches("zzzzqqqq", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(false);
  });
});

// ========================
// W-M8 unified freshness: per-wilaya severity derives from FRESH incidents
// only — the same 30-minute window the client radar uses, so a wilaya can
// never claim "critical" while the map's radar shows zero targets.
// ========================
import { deriveWilayaStatuses, isFreshThreatTimestamp } from "../server/routes/wilayas.js";

const NOW = Date.parse("2026-08-01T10:00:00Z");

const BASE = [
  { nameAr: "الجزائر - عنابة (Algérie - Annaba)", nameFr: "Algérie - Annaba", emergencyPhone: "1021" },
  { nameAr: "الجزائر - الطارف", nameFr: "Algérie - El Tarf", emergencyPhone: "1021" },
];

describe("deriveWilayaStatuses (W-M8 freshness)", () => {
  it("all-safe baseline when no incidents arrive", () => {
    const rows = deriveWilayaStatuses(BASE, [], [], NOW);
    expect(rows.every((w) => w.severity === "safe" && w.activeFires === 0)).toBe(true);
    expect(rows.every((w) => w.evacuationRecommended === false)).toBe(true);
  });

  it("a FRESH critical report drives severity + evacuation flag", () => {
    const rep = {
      wilaya: "El Tarf",
      severity: "critical",
      status: "pending",
      timestamp: "2026-08-01T09:50:00Z", // 10 min before NOW
    };
    const rows = deriveWilayaStatuses(BASE, [rep], [], NOW);
    const tarf = rows.find((w) => w.nameFr.includes("El Tarf"))!;
    expect(tarf.activeFires).toBe(1);
    expect(tarf.severity).toBe("critical");
    expect(tarf.evacuationRecommended).toBe(true);
  });

  it("a STALE report (60 min) drives NOTHING — no severity, no evacuation", () => {
    const stale = {
      wilaya: "El Tarf",
      severity: "critical",
      status: "pending",
      timestamp: "2026-08-01T09:00:00Z", // 60 min before NOW
    };
    const rows = deriveWilayaStatuses(BASE, [stale], [], NOW);
    const tarf = rows.find((w) => w.nameFr.includes("El Tarf"))!;
    expect(tarf.activeFires).toBe(0);
    expect(tarf.severity).toBe("safe");
    expect(tarf.evacuationRecommended).toBe(false);
  });

  it("resolved/rejected reports stay excluded (ARC-M04 kept on top of freshness)", () => {
    const rows = deriveWilayaStatuses(
      BASE,
      [
        { wilaya: "El Tarf", severity: "critical", status: "resolved", timestamp: "2026-08-01T09:55:00Z" },
        { wilaya: "Annaba", severity: "high", status: "rejected", timestamp: "2026-08-01T09:55:00Z" },
      ],
      [],
      NOW
    );
    expect(rows.every((w) => w.activeFires === 0 && w.severity === "safe")).toBe(true);
  });

  it("a FRESH >=80-confidence hotspot lifts safe→low; a STALE one does not", () => {
    const fresh = { wilaya: "El Tarf", confidence: 95, scanTime: "2026-08-01T09:45:00Z" };
    const stale = { wilaya: "Annaba", confidence: 95, scanTime: "2026-08-01T08:00:00Z" };
    const rows = deriveWilayaStatuses(BASE, [], [fresh, stale], NOW);
    expect(rows.find((w) => w.nameFr.includes("El Tarf"))!.severity).toBe("low");
    expect(rows.find((w) => w.nameFr.includes("Annaba"))!.severity).toBe("safe");
  });

  it("unparseable timestamps are never treated as incidents", () => {
    const rows = deriveWilayaStatuses(
      BASE,
      [{ wilaya: "El Tarf", severity: "critical", status: "pending", timestamp: "not-a-date" }],
      [{ wilaya: "Annaba", confidence: 95, scanTime: undefined }],
      NOW
    );
    expect(rows.every((w) => w.activeFires === 0 && w.severity === "safe")).toBe(true);
  });
});

describe("isFreshThreatTimestamp (server mirror)", () => {
  it("mirrors the client doctrine window", () => {
    expect(isFreshThreatTimestamp("2026-08-01T09:50:00Z", NOW)).toBe(true); // 10 min
    expect(isFreshThreatTimestamp("2026-08-01T09:30:00Z", NOW)).toBe(true); // exactly 30 min
    expect(isFreshThreatTimestamp("2026-08-01T09:29:59Z", NOW)).toBe(false); // 30 min + 1 s
    expect(isFreshThreatTimestamp("2026-08-01T10:01:00Z", NOW)).toBe(true); // +1 min skew ok
    expect(isFreshThreatTimestamp("2026-08-01T10:05:00Z", NOW)).toBe(false); // +5 min skew no
    expect(isFreshThreatTimestamp("garbage", NOW)).toBe(false);
    expect(isFreshThreatTimestamp(undefined, NOW)).toBe(false);
  });
});
