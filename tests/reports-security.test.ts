import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { vi } from "vitest";
import { validateImageDataUrl, hasImageMagicBytes } from "../server/imageValidate.js";

const mockReports = vi.hoisted(() => ({
  list: [{ id: "security-seed", lat: 36.75, lng: 7.6, severity: "medium", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1 }] as any[],
  idempotency: new Map<string, { report: any; fingerprint: string }>(),
}));

vi.mock("../server/db.js", () => ({
  getReportsDbResult: vi.fn(async () => ({ status: "ok", reports: mockReports.list })),
  seedReportsToFirestore: vi.fn(async () => true),
  lookupReportIdempotency: vi.fn(async (id: string) => {
    const entry = mockReports.idempotency.get(id);
    return entry ? { status: "found", report: entry.report, fingerprint: entry.fingerprint } : { status: "missing" };
  }),
  saveReportWithIdempotency: vi.fn(async (report: any, fingerprint: string) => {
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
  confirmReportInFirestore: vi.fn(async () => null),
  updateReportInFirestore: vi.fn(async () => true),
  deleteReportFromFirestore: vi.fn(async () => true),
}));

const mockDocs = vi.hoisted(() => new Map<string, any>());

vi.mock("express-rate-limit", () => ({
  default: () => (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../server/fs.js", () => ({
  docGet: async (collection: string, id: string) => mockDocs.get(`${collection}/${id}`) ?? null,
  docUpdate: async () => true,
  incrementDocField: async () => true,
}));

// Never hit the real Gemini Vision API from tests: the image magic-bytes
// gate is route-local logic and must be deterministic (no network, no cost).
vi.mock("../server/ai.js", () => ({
  getAiClient: () => null,
  getAiModel: () => "gemini-3-flash-preview",
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
  // Jitter far enough apart (step ~0.05 deg lng) to bypass the in-memory
  // duplicate window (0.5km), while staying inside the Annaba wilaya bounds.
  return { lat: 36.8, lng: 7.5 + coordsCounter * 0.05 };
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
    expect(res.body.image).toContain("data:image/jpeg");
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

  it("rejects base64 garbage larger than the decoded ceiling", () => {
    const big = "data:image/png;base64," + "A".repeat(1_100_000); // ~825 KB decoded
    expect(validateImageDataUrl(big)).toBe(false);
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