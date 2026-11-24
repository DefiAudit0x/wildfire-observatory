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

  it("re-checks the distinct-badge ceiling on a retry of a rejected code (Fix 41 — CMD-6)", async () => {
    // One test, four phases: the module-level per-IP map is shared across
    // tests in this file, so the whole ceiling sequence lives here.
    const beat = (deviceId: string, badgeCode: string) =>
      supertest(createApp())
        .post("/api/location/heartbeat")
        .send({ deviceId, lat: 36.75, lng: 7.6, badgeCode });
    const codes = ["CMD6-1", "CMD6-2", "CMD6-3", "CMD6-4", "CMD6-5", "CMD6-6"];
    // (a) Codes 1–5 are within the ceiling → 200 each.
    for (let i = 0; i < 5; i++) {
      expect((await beat(uniqueDevice(), codes[i])).status).toBe(200);
    }
    // (b) A retry within the ceiling still passes — the fix must not
    // blanket-block retries.
    expect((await beat(uniqueDevice(), codes[0])).status).toBe(200);
    // (c) The 6th distinct code is rejected (pre-existing behavior).
    const sixth = await beat(uniqueDevice(), codes[5]);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe("Too many badge codes from this address.");
    // (d) Retrying the rejected 6th code must 429 again. On pre-Fix-41 code
    // the retry found `seenAt` and skipped the size check → 200.
    const retry = await beat(uniqueDevice(), codes[5]);
    expect(retry.status).toBe(429);
    expect(retry.body.error).toBe("Too many badge codes from this address.");
    // (e) Fix 41b — retrying an ACCEPTED code after the rejection must
    // still 200. Fix 41 inserted the rejected code before the check, so it
    // stayed in the map at size 6 and poisoned every accepted code's retry
    // until the window expired.
    expect((await beat(uniqueDevice(), codes[0])).status).toBe(200);
  });
});
