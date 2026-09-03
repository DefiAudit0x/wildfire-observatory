import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
import commandRouter from "../server/routes/command.js";
import { buildHeartbeatPayload } from "../src/hooks/useGeolocation";
import { setReporterBadge } from "../src/utils/badgeStore";

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async (collectionName: string) =>
    collectionName === "badgeCodes"
      ? [{ code: "verified-session-badge", isActive: true, ownerName: "Operator Test", type: "volunteer" }]
      : null
  ),
  docUpdate: vi.fn(async (..._a: any[]) => true as any),
  docSet: vi.fn(async (..._a: any[]) => true as any),
  docGet: vi.fn(async (..._a: any[]) => null as any),
}));

vi.mock("../server/fs.js", () => fsMock);

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", commandRouter);
  return app;
}

describe("verified badge to heartbeat integration (S-H4 possession contract)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    // Fake ONLY the clock: the route enforces a 3 s per-device minimum
    // interval, and the two-beat possession flow needs beats > 3 s apart
    // while supertest still runs on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    fsMock.collectionGet.mockImplementation(async (collectionName: string) =>
      collectionName === "badgeCodes"
        ? [{ code: "verified-session-badge", isActive: true, ownerName: "Operator Test", type: "volunteer" }]
        : null
    );
    fsMock.docUpdate.mockClear();
    fsMock.docUpdate.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the session badge in the heartbeat and resolves it server-side once possession is proven", async () => {
    setReporterBadge("verified-session-badge");
    const payload = buildHeartbeatPayload("badge-integration-device", { lat: 36.75, lng: 7.6 });

    expect(payload.badgeCode).toBe("verified-session-badge");
    expect(localStorage.getItem("reporterBadgeCode")).toBeNull();

    const app = createApp();
    const agent = supertest.agent(app);

    // Beat 1 — no device_sig cookie yet: the server ISSUES one (bootstrap)
    // but must NOT adopt the badge owner's identity on this beat.
    const first = await agent.post("/api/location/heartbeat").send(payload);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      role: "citizen",
      identityVerified: false,
    });
    expect(first.headers["set-cookie"]).toBeDefined();

    // Beat 2 — same agent now holds the signed cookie: identity adopted and
    // the badge binds durably to THIS device. Advance past the 3 s minimum
    // per-device heartbeat interval.
    vi.advanceTimersByTime(3100);
    const second = await agent.post("/api/location/heartbeat").send(payload);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      success: true,
      name: "Operator Test",
      role: "volunteer",
      identityVerified: true,
    });
    expect(fsMock.docUpdate).toHaveBeenCalledWith(
      "badgeCodes",
      "verified-session-badge",
      expect.objectContaining({ boundDeviceId: "badge-integration-device" })
    );
  });

  it("a stolen badge code from a device without the signed cookie never adopts identity", async () => {
    setReporterBadge("verified-session-badge");
    const payload = buildHeartbeatPayload("attacker-device", { lat: 36.75, lng: 7.6 });

    const app = createApp();

    // Supertest (non-agent) keeps no cookies: the request proves knowledge of
    // the code but NOT possession of the badge-bound device.
    const res = await supertest(app).post("/api/location/heartbeat").send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      role: "citizen",
      identityVerified: false,
    });
  });

  it("a badge already bound to another device stays locked to that device", async () => {
    setReporterBadge("verified-session-badge");
    fsMock.collectionGet.mockImplementation(async (collectionName: string) =>
      collectionName === "badgeCodes"
        ? [{
            code: "verified-session-badge",
            isActive: true,
            ownerName: "Operator Test",
            type: "volunteer",
            boundDeviceId: "volunteers-own-device",
          }]
        : null
    );

    const app = createApp();
    const agent = supertest.agent(app);

    // Warm the agent's signed cookie for attacker-device-2…
    const payload = buildHeartbeatPayload("attacker-device-2", { lat: 36.75, lng: 7.6 });
    const first = await agent.post("/api/location/heartbeat").send(payload);
    expect(first.body.identityVerified).toBe(false);

    vi.advanceTimersByTime(3100);
    const second = await agent.post("/api/location/heartbeat").send(payload);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ role: "citizen", identityVerified: false, badgeBoundToDevice: true });
    // The lock must NOT have been re-written to the attacker's device.
    expect(fsMock.docUpdate).not.toHaveBeenCalled();
  });
});
