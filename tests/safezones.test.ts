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
  const zoneTest = {
    id: "zone-test", nameAr: "مركز اختبار", nameFr: "Centre Test",
    lat: 36.8, lng: 7.5, capacity: 100, hasMedical: false,
    isActive: true, createdAt: "2026-11-23T00:00:00.000Z",
  };

  it("deletes an existing zone when persistence succeeds", async () => {
    fsMock.collectionGet.mockResolvedValue([zoneTest]);
    fsMock.docDelete.mockResolvedValueOnce(true);
    const res = await supertest(createApp())
      .delete("/api/safezones/zone-test")
      .set("Authorization", `Bearer ${generateAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fsMock.docDelete).toHaveBeenCalledWith("safeZones", "zone-test");
  });

  it("returns 503 when DELETE cannot persist", async () => {
    fsMock.collectionGet.mockResolvedValue([zoneTest]);
    // The success test above already recorded a docDelete call; clear the
    // mock history so this test's assertion reads only its own request.
    fsMock.docDelete.mockClear();
    fsMock.docDelete.mockResolvedValueOnce(false);
    const res = await supertest(createApp())
      .delete("/api/safezones/zone-test")
      .set("Authorization", `Bearer ${generateAdminToken()}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("unavailable");
    expect(fsMock.docDelete).toHaveBeenCalledTimes(1);
    expect(fsMock.docDelete).toHaveBeenCalledWith("safeZones", "zone-test");
  });
});
