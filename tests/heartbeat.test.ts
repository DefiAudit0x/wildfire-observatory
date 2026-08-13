import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import commandRouter from "../server/routes/command.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", commandRouter);
  return app;
}

let deviceCounter = 0;
function uniqueDevice(): string {
  deviceCounter += 1;
  return `heartbeat-test-${Date.now()}-${deviceCounter}`;
}

describe("POST /api/location/heartbeat", () => {
  it("rejects invalid or out-of-range coordinates", async () => {
    const app = createApp();

    const invalidLatitude = await supertest(app)
      .post("/api/location/heartbeat")
      .send({ deviceId: uniqueDevice(), lat: "not-a-number", lng: 7.6 });
    expect(invalidLatitude.status).toBe(400);

    const outOfRangeLongitude = await supertest(app)
      .post("/api/location/heartbeat")
      .send({ deviceId: uniqueDevice(), lat: 36.75, lng: 181 });
    expect(outOfRangeLongitude.status).toBe(400);
  });

  it("rejects blank or oversized device identifiers", async () => {
    const app = createApp();

    const blank = await supertest(app)
      .post("/api/location/heartbeat")
      .send({ deviceId: "   ", lat: 36.75, lng: 7.6 });
    expect(blank.status).toBe(400);

    const oversized = await supertest(app)
      .post("/api/location/heartbeat")
      .send({ deviceId: "x".repeat(129), lat: 36.75, lng: 7.6 });
    expect(oversized.status).toBe(400);
  });

  it("accepts numeric coordinate strings after validation", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/location/heartbeat")
      .send({ deviceId: uniqueDevice(), lat: "36.75", lng: "7.6" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
