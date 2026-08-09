import { describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const { fakeClient, setGenerateContent } = vi.hoisted(() => {
  const fakeClient: any = { models: { generateContent: vi.fn() } };
  return { fakeClient, setGenerateContent: (impl: any) => fakeClient.models.generateContent.mockImplementation(impl) };
});

vi.mock("../server/ai.js", () => ({
  getAiClient: () => fakeClient,
  getAiModel: () => "gemini-2.0-flash",
}));

import aiRouter from "../server/routes/ai.js";

describe("POST /api/ai/guidance — provider behavior", () => {
  function createAiApp() {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use("/api/ai/guidance", aiRouter);
    return app;
  }

  it("returns the AI guidance when the provider responds with text", async () => {
    setGenerateContent(async () => ({ text: "### رد النموذج\nإرشادات رسمية من المزود" }));
    const app = createAiApp();
    const res = await supertest(app)
      .post("/api/ai/guidance")
      .set("x-forwarded-for", "203.0.113.11")
      .send({ lat: 36.8, lng: 7.5, lang: "ar" });
    expect(res.status).toBe(200);
    expect(res.body.guidance).toContain("رد النموذج");
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
  }, 25000);
});