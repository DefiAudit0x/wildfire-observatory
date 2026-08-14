import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
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
    const first = await supertest(app).post("/api/sos").send(body);
    expect(first.status).toBe(200);
    const second = await supertest(app).post("/api/sos").send(body);
    expect(second.status).toBe(409);
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
