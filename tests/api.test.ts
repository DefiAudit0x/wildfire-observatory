import { describe, it, expect } from "vitest";
import express from "express";
import reportsRouter from "../server/routes/reports.js";
import { healthHandler } from "../server/routes/health.js";
import supertest from "supertest";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/health", healthHandler);
  app.use("/api/reports", reportsRouter);
  return app;
}

describe("GET /api/health", () => {
  it("returns status ok", async () => {
    const app = createTestApp();
    const res = await supertest(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("GET /api/reports", () => {
  it("returns a list of reports", async () => {
    const app = createTestApp();
    const res = await supertest(app).get("/api/reports");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("each report has required fields", async () => {
    const app = createTestApp();
    const res = await supertest(app).get("/api/reports");
    const report = res.body[0];
    expect(report).toHaveProperty("id");
    expect(report).toHaveProperty("lat");
    expect(report).toHaveProperty("lng");
    expect(report).toHaveProperty("severity");
    expect(report).toHaveProperty("status");
    expect(report).toHaveProperty("consensusCount");
  });
});

describe("POST /api/reports", () => {
  it("returns 400 for missing fields", async () => {
    const app = createTestApp();
    const res = await supertest(app).post("/api/reports").send({});
    expect(res.status).toBe(400);
  });

  it("creates a new report with valid data", async () => {
    const app = createTestApp();
    const res = await supertest(app).post("/api/reports").send({
      lat: 36.8,
      lng: 7.6,
      locationName: "Test Location",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      description: "حريق اختبار للتحقق من النظام",
      severity: "medium",
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body.severity).toBe("medium");
    expect(res.body.status).toBe("pending");
  });

  it("accepts a photo-less report sent with image: null (as the browser does)", async () => {
    const app = createTestApp();
    const res = await supertest(app).post("/api/reports").send({
      lat: 36.75,
      lng: 7.5,
      locationName: "Test Location No Photo",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      description: "بلاغ نصي بدون صورة يجب أن يمر",
      severity: "low",
      image: null,
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body.image ?? null).toBeNull();
  });

  it("is idempotent: retrying the same clientGeneratedId returns the stored report, not a duplicate or a 409", async () => {
    const app = createTestApp();
    const payload = {
      lat: 36.86,
      lng: 7.63,
      locationName: "Idempotent Location",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      description: "بلاغ للتأكد من اللامتضاربية عند إعادة الإرسال",
      severity: "medium",
      clientGeneratedId: "cg-e2e-idempotency-0001",
    };
    const first = await supertest(app).post("/api/reports").send(payload);
    expect(first.status).toBe(200);
    const second = await supertest(app).post("/api/reports").send(payload);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toEqual(first.body);
  });

  it("does not deduplicate distinct clientGeneratedIds at the same location too eagerly past the retry rule", async () => {
    const app = createTestApp();
    const base = {
      locationName: "Two distinct submissions",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      description: "بلاغان مختلفان لنفس المنطقة القريبة",
      severity: "low",
    };
    const first = await supertest(app).post("/api/reports").send({
      ...base,
      lat: 36.83,
      lng: 7.62,
      clientGeneratedId: "cg-e2e-distinct-0001",
    });
    const second = await supertest(app).post("/api/reports").send({
      ...base,
      lat: 36.84,
      lng: 7.68,
      clientGeneratedId: "cg-e2e-distinct-0002",
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).not.toBe(first.body.id);
  });
});
