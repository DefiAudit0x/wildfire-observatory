import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

// Fix 42 (RPT-2), env-trusted path: VALID_BADGE_CODES is built at module
// load from process.env.TRUSTED_BADGE_CODES, so the env must be stubbed
// BEFORE the dynamic import (the satellite-partial pattern). The mocks
// mirror tests/reports-security.test.ts — same db/fs/ai/email/rate-limit
// surface, minus the badge-doc fixtures this path never reads.

const mockReports = vi.hoisted(() => ({
  list: [] as any[],
  idempotency: new Map<string, { report: any; fingerprint: string }>(),
}));

vi.mock("../server/db.js", () => ({
  getReportsDbResult: vi.fn(async () => ({ status: "ok", reports: mockReports.list })),
  getPublicReportsWire: vi.fn(async () => ({ status: "ok", reports: mockReports.list })),
  getReportImageDataUrl: vi.fn(async () => null),
  getReportPrivate: vi.fn(async () => null),
  sanitizePublicReport: (report: any) => {
    if (!report) return report;
    const { reporterPhone: _rp, reporterName: _rn, reporterBadgeCode: _rbc, deviceId: _did, image: _img, ...safe } = report;
    if (safe.hasImage === undefined && typeof report.image === "string" && report.image.length > 0) safe.hasImage = true;
    return safe;
  },
  seedReportsToFirestore: vi.fn(async () => true),
  lookupReportIdempotency: vi.fn(async (id: string) => {
    const entry = mockReports.idempotency.get(id);
    return entry ? { status: "found", report: entry.report, fingerprint: entry.fingerprint } : { status: "missing" };
  }),
  saveReportWithIdempotency: vi.fn(async (report: any, fingerprint: string, _canonicalize: unknown, badgeTrust?: {
    code: string;
    reporterType: string;
    wilaya: string;
    trustedReport: Record<string, unknown>;
  }) => {
    const existing = mockReports.idempotency.get(report.clientGeneratedId);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? { status: "existing", report: existing.report }
        : { status: "same_id_different_body", report: existing.report };
    }
    mockReports.idempotency.set(report.clientGeneratedId, { report, fingerprint });
    mockReports.list.unshift(report);
    return { status: "saved", report };
  }),
  confirmReportInFirestore: vi.fn(async () => ({ status: "no_db" })),
  updateReportInFirestore: vi.fn(async () => true),
  deleteReportFromFirestore: vi.fn(async () => true),
}));

vi.mock("express-rate-limit", () => ({
  default: () => (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../server/fs.js", () => ({
  docUpdate: async () => true,
}));

vi.mock("../server/ai.js", () => ({
  getAiClient: () => null,
  getAiModel: () => "gemini-3-flash-preview",
}));

const emailSpy = vi.hoisted(() => ({ sendFireAlert: vi.fn(async (_report: any) => {}) }));
vi.mock("../server/email.js", () => ({
  sendFireAlert: emailSpy.sendFireAlert,
}));

let coordsCounter = 0;
function baseReport() {
  coordsCounter += 1;
  return {
    lat: 36.8,
    lng: 7.5 + coordsCounter * 0.05,
    locationName: "غابة سيريدي",
    wilaya: "الجزائر - عنابة (Algérie - Annaba)",
    description: "حريق غابة اختبار للتحقق من نظام التصديق بالبطاقات",
    severity: "medium",
    clientGeneratedId: `cg-trusted-${coordsCounter.toString().padStart(4, "0")}`,
  };
}

describe("Fix 42 (RPT-2): env-trusted no-image reports", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("TRUSTED_BADGE_CODES", "ENV-CODE-1");
    mockReports.list.length = 0;
    mockReports.idempotency.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a trusted no-image report is verified but carries NO fabricated aiVerification", async () => {
    const { default: reportsRouter } = await import("../server/routes/reports.js");
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/api/reports", reportsRouter);
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "ENV-CODE-1" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("verified");
    expect(res.body.consensusCount).toBe(10);
    // Old code: the env-trusted else-if fabricated aiVerification
    // { isVerified: true, confidence: 100, ... } here.
    expect(res.body.aiVerification).toBeUndefined();
  });
});
