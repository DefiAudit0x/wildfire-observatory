import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
import { stripUndefinedDeep } from "../server/clean.js";
import { generateAdminToken } from "../server/middleware.js";

// ARC-C1/C2 regression guard: payloads that contain `undefined` must never
// reach Firestore (admin SDK v14 throws "Cannot use undefined as a Firestore
// value"). These tests assert the boundary at both layers: the pure sanitizer
// and the two routes whose default admin-UI flow used to 503.

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async (..._a: any[]) => [] as any),
  docGet: vi.fn(async (..._a: any[]) => null as any),
  docSet: vi.fn(async (..._a: any[]) => true as any),
  docUpdate: vi.fn(async (..._a: any[]) => true as any),
  docDelete: vi.fn(async (..._a: any[]) => true as any),
  invalidateCollectionCache: vi.fn(),
  invalidateDocCache: vi.fn(),
}));

const atomicMock = vi.hoisted(() => ({
  createDocIfAbsent: vi.fn(async (..._a: any[]) => {
    atomicMock.lastCreated = _a[2];
    return "created";
  }),
  lastCreated: null as any,
}));

vi.mock("../server/fs.js", () => fsMock);
vi.mock("../server/atomic.js", () => atomicMock);

import badgesRouter from "../server/routes/badges.js";
import volunteersRouter from "../server/routes/volunteers.js";

describe("stripUndefinedDeep (Firestore boundary sanitizer)", () => {
  it("drops undefined object keys at any depth", () => {
    const input = { a: 1, b: undefined, c: { d: undefined, e: 2, f: { g: undefined } } };
    expect(stripUndefinedDeep(input)).toEqual({ a: 1, c: { e: 2, f: {} } });
  });

  it("drops undefined array members without changing order of the rest", () => {
    expect(stripUndefinedDeep([1, undefined, "x", undefined, 3])).toEqual([1, "x", 3]);
    expect(stripUndefinedDeep({ list: [{ a: 1 }, undefined, { b: undefined }] })).toEqual({
      list: [{ a: 1 }, {}],
    });
  });

  it("passes primitives, null and class instances through untouched", () => {
    class Sentinel {}
    const date = new Date("2026-01-01T00:00:00Z");
    const sentinel = new Sentinel();
    expect(stripUndefinedDeep(5)).toBe(5);
    expect(stripUndefinedDeep(null)).toBe(null);
    expect(stripUndefinedDeep(date)).toBe(date);
    expect(stripUndefinedDeep(sentinel)).toBe(sentinel);
  });
});

describe("ARC-C2: badge creation with empty optional fields", () => {
  const adminAuth = () => ({ authorization: `Bearer ${generateAdminToken()}` });

  beforeEach(() => {
    atomicMock.lastCreated = null;
    fsMock.collectionGet.mockReset().mockResolvedValue([]);
  });

  it("writes null (not undefined) for absent phone/maxUses/expiresAt and succeeds", async () => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use("/api/badges", badgesRouter);

    const res = await supertest(app)
      .post("/api/badges")
      .set(adminAuth())
      .send({ code: "B-100", ownerName: "قائد", type: "volunteer", wilaya: "الجزائر" });

    expect(res.status).toBe(200);
    expect(atomicMock.lastCreated).toMatchObject({
      code: "B-100",
      phone: null,
      maxUses: null,
      expiresAt: null,
    });
    const written = JSON.stringify(atomicMock.lastCreated);
    expect(written).not.toContain("undefined");
  });
});

describe("ARC-C1: volunteer approval/rejection without a badge code", () => {
  const adminAuth = () => ({ authorization: `Bearer ${generateAdminToken()}` });

  beforeEach(() => {
    fsMock.collectionGet.mockReset().mockResolvedValue([]);
    fsMock.docGet.mockReset().mockResolvedValue(null);
    fsMock.docUpdate.mockReset().mockResolvedValue(true);
  });

  function createVolunteerApp() {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use("/api/volunteer", volunteersRouter);
    return app;
  }

  it("reject flow: update payload carries no assignedCode key and succeeds", async () => {
    const app = createVolunteerApp();
    // Without assignedCode there is no badgeCodes lookup — the registration
    // lookup is the only docGet call.
    fsMock.docGet.mockResolvedValueOnce({
      id: "reg-abc",
      fullName: "iv.eS.og",
      phone: "eS.og",
      wilaya: "الجزائر",
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    const res = await supertest(app)
      .post("/api/volunteer/reg-abc/approve")
      .set(adminAuth())
      .send({ status: "rejected" });

    expect(res.status).toBe(200);
    expect(fsMock.docUpdate).toHaveBeenCalledTimes(1);
    const call = fsMock.docUpdate.mock.calls[0] as any[];
    const [collection, , update] = call;
    expect(collection).toBe("volunteerRegistrations");
    expect(update).toEqual({ status: "rejected" });
    expect("assignedCode" in update).toBe(false);
  });

  it("pending flow (no badge code) also succeeds without a 503", async () => {
    const app = createVolunteerApp();
    fsMock.docGet.mockResolvedValueOnce({
      id: "reg-abc",
      fullName: "iv.eS.og",
      phone: "eS.og",
      wilaya: "الجزائر",
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    const res = await supertest(app)
      .post("/api/volunteer/reg-abc/approve")
      .set(adminAuth())
      .send({ status: "pending" });

    expect(res.status).toBe(200);
    expect((fsMock.docUpdate.mock.calls[0] as any[])[2]).toEqual({ status: "pending" });
  });
});
