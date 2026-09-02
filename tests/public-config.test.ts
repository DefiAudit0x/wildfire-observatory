import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import { publicConfigHandler } from "../server/routes/public-config.js";

function createTestApp() {
  const app = express();
  app.get("/api/config", publicConfigHandler);
  return app;
}

describe("GET /api/config", () => {
  it("serves the key when CARTO_BASEMAP_KEY is set in the environment", async () => {
    process.env.CARTO_BASEMAP_KEY = "k-env-test";
    try {
      const res = await supertest(createTestApp()).get("/api/config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cartoKey: "k-env-test" });
    } finally {
      delete process.env.CARTO_BASEMAP_KEY;
    }
  });

  it("serves cartoKey null when the env var is absent (keyless OSM stays)", async () => {
    delete process.env.CARTO_BASEMAP_KEY;
    const res = await supertest(createTestApp()).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cartoKey: null });
  });

  it("trims operator whitespace around the value", async () => {
    process.env.CARTO_BASEMAP_KEY = "  k-trim  ";
    try {
      const res = await supertest(createTestApp()).get("/api/config");
      expect(res.body).toEqual({ cartoKey: "k-trim" });
    } finally {
      delete process.env.CARTO_BASEMAP_KEY;
    }
  });
});
