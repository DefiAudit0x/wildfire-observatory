import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import type { ReportsDbResult } from "../server/db.js";

const { fakeClient, setGenerateContent, getReportsDbResult } = vi.hoisted(() => {
  const fakeClient: any = { models: { generateContent: vi.fn() } };
  return {
    fakeClient,
    setGenerateContent: (impl: any) => fakeClient.models.generateContent.mockImplementation(impl),
    getReportsDbResult: vi.fn<() => Promise<ReportsDbResult>>(),
  };
});

vi.mock("../server/db.js", () => ({
  getReportsDbResult,
}));

vi.mock("../server/ai.js", () => ({
  getAiClient: () => fakeClient,
  getAiModel: () => "gemini-3-flash-preview",
}));

import aiRouter from "../server/routes/ai.js";

beforeEach(() => {
  getReportsDbResult.mockReset();
  getReportsDbResult.mockResolvedValue({ status: "empty" });
});

describe("POST /api/ai/guidance — provider behavior", () => {
  function createAiApp() {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use("/api/ai/guidance", aiRouter);
    return app;
  }

  it("does NOT serve provider text as an all-clear with zero active reports (F046)", async () => {
    // sanitizeAiOutput only escapes HTML/dangerous schemes — it does not
    // enforce the unknown-status wording, so a provider reply like
    // "Aucun incendie à proximité" must fall through to the local
    // unknown-status fallback instead of being served as-is.
    setGenerateContent(async () => ({ text: "Aucun incendie à proximité, tout est calme." }));
    const app = createAiApp();
    const res = await supertest(app)
      .post("/api/ai/guidance")
      .set("x-forwarded-for", "203.0.113.11")
      .send({ lat: 36.8, lng: 7.5, lang: "fr" });
    expect(res.status).toBe(200);
    expect(res.body.guidance).not.toContain("Aucun incendie à proximité");
    expect(res.body.guidance).toContain("Situation des incendies inconnue");
    expect(res.body.guidance).toContain("Protection Civile: 1021");
  });

  it("serves provider text when at least one active report is nearby", async () => {
    getReportsDbResult.mockResolvedValue({
      status: "ok",
      reports: [{
        id: "rep-1",
        lat: 36.8,
        lng: 7.5,
        locationName: "Annaba",
        wilaya: "Annaba",
        description: "Fire",
        severity: "medium",
        status: "verified",
        timestamp: new Date().toISOString(),
        consensusCount: 0,
      }],
    });
    setGenerateContent(async () => ({ text: "### رد النموذج\nإرشادات رسمية من المزود" }));
    const app = createAiApp();
    const res = await supertest(app)
      .post("/api/ai/guidance")
      .set("x-forwarded-for", "203.0.113.16")
      .send({ lat: 36.8, lng: 7.5, lang: "ar" });
    expect(res.status).toBe(200);
    expect(res.body.guidance).toContain("رد النموذج");
    expect(res.body.guidance).not.toContain("غير معروفة");
  });

  it("falls back to local guidance when the provider throws (network error)", async () => {
    setGenerateContent(async () => {
      throw new Error("ECONNRESET");
    });
    const app = createAiApp();
    const res = await supertest(app)
      .post("/api/ai/guidance")
      .set("x-forwarded-for", "203.0.113.12")
      .send({ lat: 36.8, lng: 7.5, lang: "ar" });
    expect(res.status).toBe(200);
    expect(res.body.guidance).toContain("###");
    expect(res.body.guidance).toContain("حالة الحرائق غير معروفة في المنطقة الشرقية");
    expect(res.body.guidance).toContain("الحماية المدنية: 1021");
  });

  it("falls back to local guidance when the provider returns a malformed response", async () => {
    setGenerateContent(async () => null);
    const app = createAiApp();
    const res = await supertest(app)
      .post("/api/ai/guidance")
      .set("x-forwarded-for", "203.0.113.13")
      .send({ lat: 36.8, lng: 7.5, lang: "ar" });
    expect(res.status).toBe(200);
    expect(res.body.guidance).toContain("###");
    expect(res.body.guidance).toContain("حالة الحرائق غير معروفة في المنطقة الشرقية");
    expect(res.body.guidance).toContain("الحماية المدنية: 1021");
  });

  it("falls back to local guidance when the provider returns empty text", async () => {
    setGenerateContent(async () => ({ text: "   " }));
    const app = createAiApp();
    const res = await supertest(app)
      .post("/api/ai/guidance")
      .set("x-forwarded-for", "203.0.113.14")
      .send({ lat: 36.8, lng: 7.5, lang: "ar" });
    expect(res.status).toBe(200);
    expect(res.body.guidance).toContain("###");
    expect(res.body.guidance).toContain("حالة الحرائق غير معروفة في المنطقة الشرقية");
    expect(res.body.guidance).toContain("الحماية المدنية: 1021");
  });

  it("aborts a hanging provider request and serves local guidance", async () => {
    setGenerateContent(() => new Promise(() => {}));
    const app = createAiApp();
    const res = await supertest(app)
      .post("/api/ai/guidance")
      .set("x-forwarded-for", "203.0.113.15")
      .send({ lat: 36.8, lng: 7.5, lang: "ar" });
    expect(res.status).toBe(200);
    expect(res.body.guidance).toContain("###");
    expect(res.body.guidance).toContain("حالة الحرائق غير معروفة في المنطقة الشرقية");
    expect(res.body.guidance).toContain("الحماية المدنية: 1021");
  }, 25000);
});