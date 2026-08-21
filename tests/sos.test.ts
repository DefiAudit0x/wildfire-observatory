import { describe, it, expect } from "vitest";
import { beforeEach, vi } from "vitest";
import express from "express";

vi.mock("express-rate-limit", () => ({
  default: (options: { max?: number }) => {
    const counts = new WeakMap<object, Map<string, number>>();
    return (req: any, res: any, next: any) => {
      if (!options.max) return next();
      const appCounts = counts.get(req.app) || new Map<string, number>();
      counts.set(req.app, appCounts);
      const key = String(req.ip || "test");
      const count = appCounts.get(key) || 0;
      if (count >= options.max) return res.status(429).json({ error: "Too many requests" });
      appCounts.set(key, count + 1);
      return next();
    };
  },
}));
import supertest from "supertest";
import cookieParser from "cookie-parser";
import { generateAdminToken } from "../server/middleware.js";

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async () => []),
  docGet: vi.fn(async () => null),
  docSet: vi.fn(async () => true),
  docUpdate: vi.fn(async () => true),
  createSosWithAdmission: vi.fn(async () => "created"),
}));

vi.mock("../server/fs.js", () => fsMock);

import sosRouter from "../server/routes/sos.js";

function createApp() {
  const app = express();
  app.use(cookieParser("test-cookie-secret"));
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
    expect(res.status).toBe(400);
    expect(res.body.audioUrl).toBeUndefined();
    expect(res.body.hasAudio).toBeUndefined();
  });

  it("does not leak PII on the public list endpoint (audio, phone, deviceId stripped)", async () => {
    const app = createApp();
    await supertest(app).post("/api/sos").send({
      ...validBody(),
      audioUrl: "data:audio/webm;base64,AAAA",
    });
    const list = await supertest(app).get("/api/sos").set("Authorization", `Bearer ${generateAdminToken()}`);
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

    const list = await supertest(app).get("/api/sos").set("Authorization", `Bearer ${generateAdminToken()}`);
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

  it("does not claim resolve success when durable update fails", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.docUpdate.mockResolvedValueOnce(false);

    const resolve = await supertest(app)
      .post(`/api/sos/${created.body.id}/resolve`)
      .set(adminAuth());

    expect(resolve.status).toBe(503);
    expect(resolve.body.code).toBe("SOS_STORAGE_UNAVAILABLE");
  });

  it("does not claim dispatch success when durable update fails", async () => {
    const app = createApp();
    const created = await supertest(app).post("/api/sos").send(validBody());
    fsMock.collectionGet.mockResolvedValueOnce([{ id: created.body.id, dispatchedTeams: [] }] as any);
    fsMock.docUpdate.mockResolvedValueOnce(false);

    const dispatch = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ type: "protection_civile", teamNameAr: "فريق تجريبي", teamNameFr: "Équipe test" });

    expect(dispatch.status).toBe(503);
    expect(dispatch.body.code).toBe("SOS_STORAGE_UNAVAILABLE");
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
    const agent = supertest.agent(app);
    const put = await agent
      .put(`/api/sos/profile/${deviceId}`)
      .send({ name: "علي", phone: "0550123456" });
    expect(put.status).toBe(200);
    const got = await agent.get(`/api/sos/profile/${deviceId}`);
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
    expect(mismatch.status).toBe(200);
    expect(mismatch.body).toEqual({ name: "", phone: "" });
  });
});
