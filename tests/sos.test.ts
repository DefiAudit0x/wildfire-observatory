import { describe, it, expect } from "vitest";
import { beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
import { generateAdminToken } from "../server/middleware.js";

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async (..._a: any[]) => [] as any),
  docGet: vi.fn(async (..._a: any[]) => null as any),
  docSet: vi.fn(async (..._a: any[]) => true as any),
  docUpdate: vi.fn(async (..._a: any[]) => true as any),
  createSosWithAdmission: vi.fn(async (..._a: any[]) => "created" as any),
  appendSosDispatch: vi.fn(async (..._a: any[]) => "ok" as any),
  clearTeamMissionsForSos: vi.fn(async (..._a: any[]) => true as any),
  resolveSosAtomically: vi.fn(async (..._a: any[]) => ({ status: "resolved", missionsCleared: 1 }) as any),
}));

vi.mock("../server/fs.js", () => fsMock);

import sosRouter from "../server/routes/sos.js";

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/sos", sosRouter);
  return app;
}

let deviceCounter = 0;
function uniqueDevice(): string {
  deviceCounter += 1;
  return `test-dev-${Date.now()}-${deviceCounter}`;
}

function validBody() {
  return {
    deviceId: uniqueDevice(),
    lat: 36.75,
    lng: 7.6,
    name: "مختبر",
    phone: "0610000000",
  };
}

beforeEach(() => {
  fsMock.collectionGet.mockReset();
  fsMock.collectionGet.mockResolvedValue([]);
  fsMock.docGet.mockReset();
  fsMock.docGet.mockResolvedValue(null);
  fsMock.docSet.mockReset();
  fsMock.docSet.mockResolvedValue(true);
  fsMock.docUpdate.mockReset();
  fsMock.docUpdate.mockResolvedValue(true);
  fsMock.createSosWithAdmission.mockReset();
  fsMock.createSosWithAdmission.mockResolvedValue("created");
  fsMock.appendSosDispatch.mockReset();
  fsMock.appendSosDispatch.mockResolvedValue("ok");
  fsMock.clearTeamMissionsForSos.mockReset();
  fsMock.clearTeamMissionsForSos.mockResolvedValue(true);
  fsMock.resolveSosAtomically.mockReset();
  fsMock.resolveSosAtomically.mockResolvedValue({ status: "resolved", missionsCleared: 1 });
});

describe("POST /api/sos", () => {
  it("accepts a valid SOS", async () => {
    const app = createApp();
    const res = await supertest(app).post("/api/sos").send(validBody());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body.status).toBe("active");
    expect(res.body.priority).toBeDefined();
  });

  it("returns 400 for missing required fields", async () => {
    const app = createApp();
    const res = await supertest(app).post("/api/sos").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for coordinates outside coverage (North Africa geofence)", async () => {
    const app = createApp();
    const res = await supertest(app).post("/api/sos").send({
      ...validBody(),
      lat: 55.0,
      lng: -4.0,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside/i);
  });

  it("rejects duplicate SOS from the same device within the guard window", async () => {
    const app = createApp();
    const body = validBody();
    fsMock.createSosWithAdmission.mockResolvedValueOnce("created").mockResolvedValueOnce("duplicate");
    const first = await supertest(app).post("/api/sos").send(body);
    expect(first.status).toBe(200);
    const second = await supertest(app).post("/api/sos").send(body);
    expect(second.status).toBe(409);
  });

  it("does not claim success or consume duplicate capacity when durable SOS storage fails", async () => {
    const app = createApp();
    const body = validBody();
    fsMock.createSosWithAdmission.mockResolvedValueOnce("unavailable").mockResolvedValueOnce("created");

    const failed = await supertest(app).post("/api/sos").send(body);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("SOS_STORAGE_UNAVAILABLE");

    const retry = await supertest(app).post("/api/sos").send(body);
    expect(retry.status).toBe(200);
    expect(fsMock.createSosWithAdmission).toHaveBeenCalledTimes(2);
  });

  it("clamps audioDuration to the configured maximum", async () => {
    const app = createApp();
    const res = await supertest(app).post("/api/sos").send({
      ...validBody(),
      audioDuration: 999,
    });
    expect(res.status).toBe(200);
    expect(res.body.audioDuration).toBeLessThanOrEqual(20);
  });

  it("caps oversized audio payloads", async () => {
    const app = createApp();
    const bigAudio = `data:audio/webm;base64,${"a".repeat(800 * 1024)}`;
    const res = await supertest(app).post("/api/sos").send({
      ...validBody(),
      audioUrl: bigAudio,
    });
    expect(res.status).toBe(400);
  });

  it("exposes metadata (priority, nearby-fire corroboration) on successful SOS", async () => {
    const app = createApp();
    const res = await supertest(app).post("/api/sos").send(validBody());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("priority");
    expect(res.body).toHaveProperty("nearbyFireCorroborated");
    expect(res.body).toHaveProperty("nearestFireDistanceKm");
  });

  it("does not leak raw audio in the POST response (only a hasAudio flag)", async () => {
    const app = createApp();
    const res = await supertest(app).post("/api/sos").send({
      ...validBody(),
      audioUrl: "data:audio/webm;base64,AAAA",
    });
    expect(res.status).toBe(200);
    expect(res.body.audioUrl).toBeUndefined();
    expect(res.body.hasAudio).toBe(true);
  });

  it("does not leak PII on the public list endpoint (audio, phone, deviceId stripped)", async () => {
    const app = createApp();
    await supertest(app).post("/api/sos").send({
      ...validBody(),
      audioUrl: "data:audio/webm;base64,AAAA",
    });
    const list = await supertest(app).get("/api/sos");
    expect(list.status).toBe(200);
    for (const item of list.body) {
      expect(item.audioUrl).toBeUndefined();
      expect(item.phone).toBeUndefined();
      expect(item.name).toBeUndefined();
      expect(item.deviceId).toBeUndefined();
    }
  });

  it("labels a public SOS list as a memory fallback when Firestore is unavailable", async () => {
    const app = createApp();
    await supertest(app).post("/api/sos").send(validBody());
    fsMock.collectionGet.mockResolvedValueOnce(null as any);

    const list = await supertest(app).get("/api/sos");
    expect(list.status).toBe(200);
    expect(list.headers["x-sos-source"]).toBe("memory_fallback");
  });
});

describe("POST /api/sos rate limiting", () => {
  it("returns 429 after too many posts in a short window", async () => {
    const app = createApp();
    const limiterDevice = uniqueDevice();
    let got429 = false;
    for (let i = 0; i < 8; i++) {
      const res = await supertest(app).post("/api/sos").send({ ...validBody(), deviceId: limiterDevice });
      if (res.status === 429) got429 = true;
    }
    expect(got429).toBe(true);
  });
});

describe("SOS durable lifecycle mutations", () => {
  const adminAuth = () => ({ authorization: `Bearer ${generateAdminToken()}` });

  it("B4: resolve runs the atomic tx and surfaces the cleared-mission count", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.resolveSosAtomically.mockResolvedValueOnce({ status: "resolved", missionsCleared: 2 });

    const resolve = await supertest(app)
      .post(`/api/sos/${created.body.id}/resolve`)
      .set(adminAuth());

    expect(resolve.status).toBe(200);
    expect(resolve.body.success).toBe(true);
    expect(resolve.body.missionsCleared).toBe(2);
    expect(fsMock.resolveSosAtomically).toHaveBeenCalledWith(created.body.id);
  });

  it("B4: 404 when the SOS doc is missing (the tx knows, no silent guess)", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.resolveSosAtomically.mockResolvedValueOnce({ status: "missing" });

    const resolve = await supertest(app)
      .post(`/api/sos/${created.body.id}/resolve`)
      .set(adminAuth());

    expect(resolve.status).toBe(404);
  });

  it("does not claim resolve success when durable update fails", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.resolveSosAtomically.mockResolvedValueOnce({ status: "unavailable" });

    const resolve = await supertest(app)
      .post(`/api/sos/${created.body.id}/resolve`)
      .set(adminAuth());

    expect(resolve.status).toBe(503);
    expect(resolve.body.code).toBe("SOS_STORAGE_UNAVAILABLE");
  });

  it("does not claim dispatch success when durable update fails", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.docGet.mockResolvedValueOnce({ teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true });
    fsMock.appendSosDispatch.mockResolvedValueOnce("unavailable");

    const dispatch = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "" });

    expect(dispatch.status).toBe(503);
    expect(dispatch.body.code).toBe("SOS_STORAGE_UNAVAILABLE");
  });

  it("rejects dispatching to a resolved SOS with 409 (atomic transaction guard)", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.docGet.mockResolvedValueOnce({ teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true });
    fsMock.appendSosDispatch.mockResolvedValueOnce("resolved");

    const dispatch = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha" });

    expect(dispatch.status).toBe(409);
    expect(dispatch.body.error).toMatch(/resolved/i);
  });

  it("rejects a team already on an active mission with 409 (ARC-H8 uniqueness)", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.docGet.mockResolvedValueOnce({ teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true });
    fsMock.appendSosDispatch.mockResolvedValueOnce("team_busy");

    const dispatch = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha" });

    expect(dispatch.status).toBe(409);
    expect(dispatch.body.code).toBe("TEAM_ALREADY_DISPATCHED");
  });

  it("404s phantom teams — legacy free-text dispatch was purged (v2.3.0)", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    // docGet defaults to null in beforeEach: no team entity ⇒ no dispatch.
    const legacy = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ type: "protection_civile", teamNameAr: "RAPIDE 1", teamNameFr: "RAPIDE 1" });
    expect(legacy.status).toBe(400);

    const unknownTeam = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-ghost" });
    expect(unknownTeam.status).toBe(404);
  });

  it("passes the registered teamId as the mission identity", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.docGet.mockResolvedValueOnce({ teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true });
    await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha" });

    const missionId = fsMock.appendSosDispatch.mock.calls[0][2];
    expect(missionId).toBe("team-alpha");
  });
});

describe("Profile endpoints (server-side encrypted identity)", () => {
  it("returns empty profile for an unknown device", async () => {
    const app = createApp();
    const res = await supertest(app).get(`/api/sos/profile/${uniqueDevice()}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("");
    expect(res.body.phone).toBe("");
  });

  it("stores a profile and returns it back (encrypted-at-rest on server)", async () => {
    const app = createApp();
    const deviceId = uniqueDevice();
    const put = await supertest(app)
      .put(`/api/sos/profile/${deviceId}`)
      .send({ name: "علي", phone: "0550123456" });
    expect(put.status).toBe(200);
    const got = await supertest(app).get(`/api/sos/profile/${deviceId}`);
    expect(got.status).toBe(200);
    expect(got.body.name).toBe("علي");
    expect(got.body.phone).toBe("0550123456");
  });

  it("does not report successful profile storage when the durable write fails", async () => {
    const app = createApp();
    const deviceId = uniqueDevice();
    fsMock.docSet.mockResolvedValueOnce(false);
    const put = await supertest(app)
      .put(`/api/sos/profile/${deviceId}`)
      .send({ name: "علي", phone: "0550123456" });
    expect(put.status).toBe(503);

    const got = await supertest(app).get(`/api/sos/profile/${deviceId}`);
    expect(got.body).toEqual({ name: "", phone: "" });
  });

  it("validates profile inputs", async () => {
    const app = createApp();
    const res = await supertest(app)
      .put(`/api/sos/profile/${uniqueDevice()}`)
      .send({ name: "x".repeat(500) });
    expect(res.status).toBe(400);
  });

  it("rejects a profile request for another device after the browser is bound", async () => {
    const agent = supertest.agent(createApp());
    const firstDevice = uniqueDevice();
    const secondDevice = uniqueDevice();

    const first = await agent.get(`/api/sos/profile/${firstDevice}`);
    expect(first.status).toBe(200);

    const mismatch = await agent.get(`/api/sos/profile/${secondDevice}`);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toContain("mismatch");
  });
});

describe("POST /api/sos — F4 clientGeneratedId idempotency", () => {
  function sosBody(cgid?: string) {
    return { ...validBody(), clientGeneratedId: cgid };
  }

  it("rejects a clientGeneratedId shorter than the schema floor", async () => {
    const app = createApp();
    const res = await supertest(app).post("/api/sos").send(sosBody("short"));
    expect(res.status).toBe(400);
  });

  it("replays the FIRST stored SOS when the same clientGeneratedId is retried in-process", async () => {
    const app = createApp();
    const cgid = "cg-sos-retry-0001";

    const first = await supertest(app).post("/api/sos").send(sosBody(cgid));
    expect(first.status).toBe(200);
    const firstId = first.body.id;

    const retry = await supertest(app).post("/api/sos").send(sosBody(cgid));
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(firstId);

    // exactly ONE durable admission happened for the pair of requests
    expect(fsMock.createSosWithAdmission).toHaveBeenCalledTimes(1);
  });

  it("replays from the durable ledger after process death (memory empty)", async () => {
    const cgid = "cg-sos-retry-0002";
    fsMock.docGet.mockImplementation(async (col: string, id: string) => {
      if (col === "sosIdempotency" && id === cgid) {
        return { sosId: "sos-durable-42", deviceId: "dev-x" };
      }
      if (col === "trappedSos" && id === "sos-durable-42") {
        return { id: "sos-durable-42", deviceId: "dev-x", lat: 36.75, lng: 7.6, status: "pending" };
      }
      return null;
    });

    const app = createApp();
    const res = await supertest(app).post("/api/sos").send(sosBody(cgid));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("sos-durable-42");
    // no new admission for a replay
    expect(fsMock.createSosWithAdmission).not.toHaveBeenCalled();
  });

  it("admits a NEW SOS when the ledger lookup fails — an emergency is never blocked", async () => {
    const cgid = "cg-sos-retry-0003";
    fsMock.docGet.mockImplementation(async (col: string) => {
      if (col === "sosIdempotency") throw new Error("ledger down");
      return null;
    });

    const app = createApp();
    const res = await supertest(app).post("/api/sos").send(sosBody(cgid));
    expect(res.status).toBe(200);
    expect(fsMock.createSosWithAdmission).toHaveBeenCalledTimes(1);
    expect(fsMock.docSet).toHaveBeenCalledWith(
      "sosIdempotency",
      cgid,
      expect.objectContaining({ sosId: res.body.id }),
    );
  });

  it("distinct clientGeneratedIds create distinct SOS calls", async () => {
    const app = createApp();
    const a = await supertest(app).post("/api/sos").send(sosBody("cg-sos-distinct-a"));
    const b = await supertest(app).post("/api/sos").send(sosBody("cg-sos-distinct-b"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).not.toBe(b.body.id);
    expect(fsMock.createSosWithAdmission).toHaveBeenCalledTimes(2);
  });
});
