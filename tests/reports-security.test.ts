import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { vi } from "vitest";
import { validateImageDataUrl, hasImageMagicBytes, MAX_IMAGE_BYTES } from "../server/imageValidate.js";

const mockReports = vi.hoisted(() => ({
  list: [{ id: "security-seed", lat: 36.75, lng: 7.6, severity: "medium", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1 }] as any[],
  idempotency: new Map<string, { report: any; fingerprint: string }>(),
}));

vi.mock("../server/db.js", async (importOriginal) => ({
  getReportsDbResult: vi.fn(async () => ({ status: "ok", reports: mockReports.list })),
  // v2.4.0 (S-H2): the route serves the pre-sanitized wire; sanitize strips
  // PII AND the inline image (replaced by hasImage + GET /:id/image).
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
  // Exercise the actual transactional badge predicates, not a replica here.
  saveReportWithIdempotency: (await importOriginal<typeof import("../server/db.js")>()).saveReportWithIdempotency,
  confirmReportInFirestore: vi.fn(async () => ({ status: "no_db" })),
  updateReportInFirestore: vi.fn(async () => true),
}));

const mockDocs = vi.hoisted(() => new Map<string, any>());

vi.mock("../server/firebase.js", async () => {
  const { memoryAdminDb } = await import("./helpers/memoryAdminDb");
  const db = memoryAdminDb(mockDocs);
  return { getDb: () => db, isAdminDb: () => true };
});

vi.mock("express-rate-limit", () => ({
  default: () => (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../server/fs.js", () => ({
  docUpdate: async () => true,
}));

// Never hit the real Gemini Vision API from tests: the image magic-bytes
// gate is route-local logic and must be deterministic (no network, no cost).
vi.mock("../server/ai.js", () => ({
  getAiClient: () => null,
  getAiModel: () => "gemini-3-flash-preview",
}));

// v2.15.0: alert-pipeline gate — spy on the fan-out email; never hit a real
// provider from tests.
const emailSpy = vi.hoisted(() => ({ sendFireAlert: vi.fn(async (_report: any) => {}) }));
vi.mock("../server/email.js", () => ({
  sendFireAlert: emailSpy.sendFireAlert,
}));

const { default: reportsRouter } = await import("../server/routes/reports.js");

function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/reports", reportsRouter);
  return app;
}

let coordsCounter = 0;
function annabaCoords() {
  coordsCounter += 1;
  // Jitter far enough apart (step ~0.03 deg lng, ~2.7 km) to bypass the
  // in-memory duplicate window (0.5km), while staying inside the Annaba
  // wilaya bounds (lng 7.4–7.95): the step fits 15 calls, and the badge
  // describe makes 12 — the old 0.05 step fit only 9, so the 10th call
  // already fell outside Annaba (Fix 66: two new badge tests pushed the
  // RPT-2 and future-expiry tests past the boundary).
  return { lat: 36.8, lng: 7.5 + coordsCounter * 0.03 };
}

function baseReport() {
  const { lat, lng } = annabaCoords();
  return {
    lat,
    lng,
    locationName: "غابة سيريدي",
    wilaya: "الجزائر - عنابة (Algérie - Annaba)",
    description: "حريق غابة اختبار للتحقق من نظام التصديق بالبطاقات",
    severity: "medium",
    clientGeneratedId: `cg-security-${coordsCounter.toString().padStart(4, "0")}`,
  };
}

describe("POST /api/reports — badge trust hardening", () => {
  beforeEach(() => {
    mockDocs.clear();
    mockReports.list.length = 0;
    mockReports.idempotency.clear();
  });

  it("rejects an inactive badge (isActive=false) — no trust elevation", async () => {
    mockDocs.set("badgeCodes/888", { isActive: false, type: "official" });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "888" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.consensusCount).toBe(1);
  });

  it("rejects a badge whose isActive is unset", async () => {
    mockDocs.set("badgeCodes/777", { type: "volunteer" });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "volunteer", reporterBadgeCode: "777" });
    expect(res.body.status).toBe("pending");
  });

  it("rejects a badge with a type mismatch", async () => {
    mockDocs.set("badgeCodes/150", { isActive: true, type: "official" });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "volunteer", reporterBadgeCode: "150" });
    expect(res.body.status).toBe("pending");
  });

  it("rejects an expired badge", async () => {
    mockDocs.set("badgeCodes/193", {
      isActive: true,
      type: "official",
      expiresAt: "2025-01-01T00:00:00.000Z",
    });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "193" });
    expect(res.body.status).toBe("pending");
  });

  it("rejects a badge with an unparseable expiry string — corrupt expiry never verifies", async () => {
    mockDocs.set("badgeCodes/194", {
      isActive: true,
      type: "official",
      expiresAt: "invalid-expiry",
    });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "194" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.consensusCount).toBe(1);
  });

  it("rejects a badge with a non-finite numeric expiry — Infinity never verifies", async () => {
    mockDocs.set("badgeCodes/195", {
      isActive: true,
      type: "official",
      expiresAt: Infinity,
    });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "195" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.consensusCount).toBe(1);
  });

  it("rejects a badge past its usage cap", async () => {
    mockDocs.set("badgeCodes/198", {
      isActive: true,
      type: "official",
      maxUses: 3,
      usedCount: 3,
    });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "198" });
    expect(res.body.status).toBe("pending");
  });

  it("rejects a badge bound to another wilaya", async () => {
    mockDocs.set("badgeCodes/1021", {
      isActive: true,
      type: "official",
      wilaya: "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)",
    });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "1021" });
    expect(res.body.status).toBe("pending");
  });

  it("accepts an active, matching, unexpired badge — verified with consensus 10", async () => {
    mockDocs.set("badgeCodes/707", { isActive: true, type: "official" });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "707" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("verified");
    expect(res.body.consensusCount).toBe(10);
  });

  it("Fix 42 (RPT-2): a trusted no-image report is verified but carries NO fabricated aiVerification", async () => {
    // The old code fabricated aiVerification { isVerified: true, confidence:
    // 100, ... } for trusted reports with no image, and the client renders
    // that as a green "verified by AI" badge. The badge grant (verified +
    // consensus 10) is real and stays; the AI verdict must stay absent
    // until the image branch sets it from a real model response.
    mockDocs.set("badgeCodes/708", { isActive: true, type: "official" });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "official", reporterBadgeCode: "708" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("verified");
    expect(res.body.consensusCount).toBe(10);
    expect(res.body.aiVerification).toBeUndefined();
  });

  it("accepts an active badge with a future expiry and wilaya match", async () => {
    mockDocs.set("badgeCodes/555", {
      isActive: true,
      type: "volunteer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
    });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterType: "volunteer", reporterBadgeCode: "555" });
    expect(res.body.status).toBe("verified");
    expect(res.body.consensusCount).toBe(10);
  });

  it("never leaks reporter PII on the public response (phone, name, badge, deviceId)", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterName: "مختبر", reporterPhone: "0661234567", reporterBadgeCode: "707", deviceId: "dev-abc" });
    expect(res.body.reporterPhone).toBeUndefined();
    expect(res.body.reporterName).toBeUndefined();
    expect(res.body.reporterBadgeCode).toBeUndefined();
    expect(res.body.deviceId).toBeUndefined();
  });

  it("rejects coordinates outside the North Africa geofence", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), lat: 48.85, lng: 2.35 });
    expect(res.status).toBe(400);
  });

  it("rejects coordinates outside the selected wilaya bounds", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), lat: 36.5, lng: 8.5 });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/reports — v2.15.0 alert pipeline gate", () => {
  // Fixed, well-inside-Annaba coords (the shared annabaCoords() counter has
  // marched east past the wilaya bounds by the time this block runs) and
  // >0.5km apart so the in-memory duplicate window never dedupes them.
  const alertCoords: Array<{ lat: number; lng: number; cg: string }> = [
    { lat: 36.77, lng: 7.44, cg: "cg-alert-1" },
    { lat: 36.77, lng: 7.49, cg: "cg-alert-2" },
    { lat: 36.77, lng: 7.54, cg: "cg-alert-3" },
  ];
  let alertIdx = 0;
  function alertReport(extra: Record<string, unknown>) {
    const c = alertCoords[alertIdx++]!;
    return {
      lat: c.lat,
      lng: c.lng,
      locationName: "غابة سيريدي",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      description: "حريق غابة اختبار بوابة التنبيهات",
      clientGeneratedId: c.cg,
      ...extra,
    };
  }

  it("does NOT alert on a citizen critical report that is still pending", async () => {
    emailSpy.sendFireAlert.mockClear();
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send(alertReport({ severity: "critical" }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(emailSpy.sendFireAlert).not.toHaveBeenCalled();
  });

  it("alerts when a badge-verified report is high/critical (trusted path)", async () => {
    emailSpy.sendFireAlert.mockClear();
    mockDocs.set("badgeCodes/808", { isActive: true, type: "official" });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send(alertReport({ severity: "critical", reporterType: "official", reporterBadgeCode: "808" }));
    expect(res.body.status).toBe("verified");
    await vi.waitFor(() => expect(emailSpy.sendFireAlert).toHaveBeenCalledTimes(1));
    expect(emailSpy.sendFireAlert.mock.calls[0][0]).toMatchObject({ severity: "critical", status: "verified" });
  });

  it("does NOT alert on a badge-verified low/medium report", async () => {
    emailSpy.sendFireAlert.mockClear();
    mockDocs.set("badgeCodes/809", { isActive: true, type: "official" });
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send(alertReport({ severity: "medium", reporterType: "official", reporterBadgeCode: "809" }));
    expect(res.body.status).toBe("verified");
    expect(emailSpy.sendFireAlert).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports — image magic-bytes gate", () => {
  const VALID_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="; // FF D8 FF E0 ...
  const VALID_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const FAKE_TEXT_AS_IMAGE = "data:image/png;base64,PGh0bWw+PC9odG1sPg=="; // "<html></html>"
  const CORRUPT_JPEG = "data:image/jpeg;base64,AAAA";

  // The badge suite above consumed the shared Annaba jitter counter up to
  // lng ~8.05 (near the wilaya's 7.95 bound), so these reports use a
  // DIFFERENT in-bounds base coordinate, stepped 0.03° to stay outside the
  // 0.5 km duplicate window while remaining inside Annaba (7.4–7.95).
  let imageCoordsCounter = 0;
  function imageBaseReport() {
    imageCoordsCounter += 1;
    return {
      ...baseReport(),
      lat: 36.75,
      lng: 7.45 + imageCoordsCounter * 0.03,
    };
  }

  it("accepts a real JPEG data URL", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...imageBaseReport(), image: VALID_JPEG });
    expect(res.status).toBe(200);
    // S-H2: the photo body NEVER travels back on the wire — the response
    // carries hasImage instead (the photo is fetched via GET /:id/image).
    expect(res.body.image).toBeUndefined();
    expect(res.body.hasImage).toBe(true);
  });

  it("accepts a real PNG data URL", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...imageBaseReport(), image: VALID_PNG });
    expect(res.status).toBe(200);
  });

  it("rejects text masquerading as an image (no magic bytes)", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...imageBaseReport(), image: FAKE_TEXT_AS_IMAGE });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("الصورة");
  });

  it("rejects a corrupt/undecodable data URL", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...imageBaseReport(), image: CORRUPT_JPEG });
    expect(res.status).toBe(400);
  });

  it("rejects a JPEG whose magic bytes are missing even with a valid header claim", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...imageBaseReport(), image: "data:image/webp;base64,AAAA" });
    expect(res.status).toBe(400);
  });

  it("never rejects a report without an image", async () => {
    const app = createApp();
    const res = await supertest(app).post("/api/reports").send(imageBaseReport());
    expect(res.status).toBe(200);
    expect(res.body.image).toBeUndefined();
    expect(res.body.hasImage).toBeUndefined();
  });
});

describe("validateImageDataUrl — helper edge cases", () => {
  it("rejects non-image data URLs and plain strings", () => {
    expect(validateImageDataUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(validateImageDataUrl("http://example.com/img.png")).toBe(false);
    expect(validateImageDataUrl("")).toBe(false);
  });

  it("rejects a data URL with no comma separator", () => {
    expect(validateImageDataUrl("data:image/png;base64AAA")).toBe(false);
  });

  it("rejects a signature-valid image larger than the decoded ceiling", () => {
    // PNG magic alone makes hasImageMagicBytes true, so ONLY the
    // 700-KiB ceiling can reject this fixture: the old fixture
    // (1,100,000 'A's decoding to zeros) failed the magic check
    // instead and never exercised the ceiling.
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const oversized = Buffer.concat([pngHead, Buffer.alloc(MAX_IMAGE_BYTES - pngHead.length + 1)]);
    const big = "data:image/png;base64," + oversized.toString("base64");
    expect(validateImageDataUrl(big)).toBe(false);
    // Positive control: the same magic at a small size passes, so the
    // rejection above is the ceiling's doing, not the magic check's.
    const small = "data:image/png;base64," + Buffer.concat([pngHead, Buffer.alloc(100)]).toString("base64");
    expect(validateImageDataUrl(small)).toBe(true);
  });

  it("recognizes the four supported magic bytes families", () => {
    expect(hasImageMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]))).toBe(true); // JPEG
    expect(hasImageMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]))).toBe(true); // PNG
    expect(hasImageMagicBytes(Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"))).toBe(true); // WebP
    expect(hasImageMagicBytes(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"))).toBe(true); // GIF
    expect(hasImageMagicBytes(Buffer.from("nope-not-an-image", "latin1"))).toBe(false);
    expect(hasImageMagicBytes(Buffer.alloc(0))).toBe(false);
  });
});
