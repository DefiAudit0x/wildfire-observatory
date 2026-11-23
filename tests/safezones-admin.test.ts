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

const zoneA = {
  id: "zone-a",
  nameAr: "مركز أ",
  nameFr: "Centre A",
  lat: 36.5,
  lng: 7.6,
  capacity: 1000,
  hasMedical: true,
  isActive: true,
  createdAt: "2026-11-23T00:00:00.000Z",
};

const zoneB = {
  id: "zone-b",
  nameAr: "مركز ب",
  nameFr: "Centre B",
  lat: 36.6,
  lng: 7.7,
  capacity: 500,
  hasMedical: false,
  isActive: true,
  createdAt: "2026-11-23T00:00:00.000Z",
};

describe("safe-zones admin endpoint (Fix 26 — SZM-1)", () => {
  it("the public GET excludes inactive records even with an admin token", async () => {
    fsMock.collectionGet.mockResolvedValue([zoneA, { ...zoneB, isActive: false }]);
    const res = await supertest(createApp())
      .get("/api/safezones")
      .set("Authorization", `Bearer ${generateAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("zone-a");
  });

  it("GET /admin with an admin token returns the full list including inactive records", async () => {
    fsMock.collectionGet.mockResolvedValue([zoneA, { ...zoneB, isActive: false }]);
    const res = await supertest(createApp())
      .get("/api/safezones/admin")
      .set("Authorization", `Bearer ${generateAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((z: { id: string }) => z.id).sort()).toEqual(["zone-a", "zone-b"]);
  });

  it("GET /admin without a token is 401", async () => {
    const res = await supertest(createApp()).get("/api/safezones/admin");
    expect(res.status).toBe(401);
  });

  it("a PUT toggle to inactive hides the zone publicly but keeps it on /admin", async () => {
    // The PUT reads through the cached list (populated by the earlier GETs),
    // so the mock's new value is only consumed by the reads after the toggle.
    fsMock.collectionGet.mockResolvedValue([zoneA, { ...zoneB, isActive: false }]);
    fsMock.docUpdate.mockResolvedValue(true);
    const put = await supertest(createApp())
      .put("/api/safezones/zone-b")
      .set("Authorization", `Bearer ${generateAdminToken()}`)
      .send({ ...zoneB, isActive: false });
    expect(put.status).toBe(200);
    // Fix 26b (watch Minor 4666538099): the GET assertions below only read
    // the pre-seeded mock, so a PUT returning 200 without writing would
    // pass them — pin the write itself.
    expect(fsMock.docUpdate).toHaveBeenCalledWith(
      "safeZones",
      "zone-b",
      expect.objectContaining({ isActive: false })
    );

    const pub = await supertest(createApp())
      .get("/api/safezones")
      .set("Authorization", `Bearer ${generateAdminToken()}`);
    expect(pub.status).toBe(200);
    expect(pub.body.map((z: { id: string }) => z.id)).toEqual(["zone-a"]);

    const admin = await supertest(createApp())
      .get("/api/safezones/admin")
      .set("Authorization", `Bearer ${generateAdminToken()}`);
    expect(admin.status).toBe(200);
    expect(admin.body.map((z: { id: string }) => z.id).sort()).toEqual(["zone-a", "zone-b"]);
    expect(admin.body.find((z: { id: string }) => z.id === "zone-b").isActive).toBe(false);
  });
});
