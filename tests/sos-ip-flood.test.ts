import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";

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
  // Trust one proxy hop so X-Forwarded-For drives req.ip — the flood test
  // then pins ONE address, exactly like a real attacker.
  app.set("trust proxy", 1);
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
  fsMock.createSosWithAdmission.mockReset();
  fsMock.createSosWithAdmission.mockResolvedValue("created");
});

// Own file on purpose: the rate limiter's bucket lives at MODULE scope, so
// the flood this test fires must not contaminate sos.test.ts expectations.
describe("S-H3: IP-level flood gate", () => {
  it("deviceIds rotation cannot exceed the per-address SOS budget", async () => {
    const app = createApp();
    // Each post uses a FRESH deviceId (the per-device 2/min window never
    // trips). The address-level limiter (10 per 2 min) is what stops the
    // rotation — the attacker's budget runs out at the IP, not the device.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await supertest(app)
        .post("/api/sos")
        .set("X-Forwarded-For", "10.99.0.7")
        .send(validBody());
      statuses.push(res.status);
    }
    const rejected = statuses.filter((s) => s === 429).length;
    expect(rejected).toBeGreaterThanOrEqual(2);
    // Every request BEFORE the cap was admitted honestly (no other status).
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(10);
  });

  it("a second honest device on a different address is unaffected by another address's flood", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/sos")
      .set("X-Forwarded-For", "10.99.0.8")
      .send(validBody());
    expect(res.status).toBe(200);
  });
});
