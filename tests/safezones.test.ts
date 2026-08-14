import express from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { generateAdminToken } from "../server/middleware.js";

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(),
  docSet: vi.fn(),
  docUpdate: vi.fn(),
  docDelete: vi.fn(),
  docGet: vi.fn(),
}));

vi.mock("../server/fs.js", () => fsMock);

const { default: safezonesRouter } = await import("../server/routes/safezones.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/safezones", safezonesRouter);
  return app;
}

describe("safe-zone persistence failures", () => {
  it("returns 503 when DELETE cannot persist", async () => {
    fsMock.docDelete.mockResolvedValueOnce(false);
    const res = await supertest(createApp())
      .delete("/api/safezones/zone-test")
      .set("Authorization", `Bearer ${generateAdminToken()}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("unavailable");
  });
});
