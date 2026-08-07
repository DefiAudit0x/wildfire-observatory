import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { vi } from "vitest";

const mockDocs = vi.hoisted(() => new Map<string, any>());

vi.mock("express-rate-limit", () => ({
  default: () => (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../server/fs.js", () => ({
  docGet: async (collection: string, id: string) => mockDocs.get(`${collection}/${id}`) ?? null,
  docUpdate: async () => true,
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
  };
}

describe("POST /api/reports — badge trust hardening", () => {
  beforeEach(() => {
    mockDocs.clear();
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

  it("never leaks the reporter phone on the response", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports")
      .send({ ...baseReport(), reporterName: "مختبر", reporterPhone: "0661234567" });
    expect(res.body.reporterPhone).toBeUndefined();
    expect(res.body.reporterName).toBeDefined();
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