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
      lat: 36.5,
      lng: 7.5,
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
});
