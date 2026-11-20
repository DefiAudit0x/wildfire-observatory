import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
import { issueDeviceCookie } from "../server/deviceBinding.js";
import commandRouter from "../server/routes/command.js";
import { buildHeartbeatPayload } from "../src/hooks/useGeolocation";
import { setReporterBadge } from "../src/utils/badgeStore";

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async (collectionName: string) =>
    collectionName === "badgeCodes"
      ? [{ code: "verified-session-badge", isActive: true, ownerName: "Operator Test", type: "volunteer", boundDeviceId: fsMock.badgeOwner }]
      : null
  ),
  badgeOwner: null as string | null,
  bindBadgeDeviceAtomic: vi.fn(async (_code: string, _deviceId: string) => "unavailable" as "bound" | "already_bound" | "conflict" | "unavailable"),
  docUpdate: vi.fn(async (..._a: any[]) => true as any),
  docSet: vi.fn(async (..._a: any[]) => true as any),
  docGet: vi.fn(async (..._a: any[]) => null as any),
}));

vi.mock("../server/fs.js", () => fsMock);

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.post("/test/device/:id", (req, res) => {
    issueDeviceCookie(res, req.params.id);
    res.sendStatus(204);
  });
  app.use("/api", commandRouter);
  return app;
}

describe("verified badge to heartbeat integration (S-H4 possession contract)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    // Fake ONLY the clock: the route enforces a 3 s per-device minimum
    // interval, so repeat beats must be > 3 s apart
    // while supertest still runs on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    fsMock.collectionGet.mockImplementation(async (collectionName: string) =>
      collectionName === "badgeCodes"
        ? [{ code: "verified-session-badge", isActive: true, ownerName: "Operator Test", type: "volunteer", boundDeviceId: fsMock.badgeOwner }]
        : null
    );
    fsMock.docUpdate.mockClear();
    fsMock.docUpdate.mockResolvedValue(true);
    fsMock.badgeOwner = null;
    fsMock.bindBadgeDeviceAtomic.mockImplementation(async (_code, deviceId) => {
      if (fsMock.badgeOwner && fsMock.badgeOwner !== deviceId) return "conflict";
      if (fsMock.badgeOwner === deviceId) return "already_bound";
      fsMock.badgeOwner = deviceId;
      return "bound";
    });
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

    // An unsigned heartbeat stays anonymous.
    const first = await agent.post("/api/location/heartbeat").send(payload);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      role: "citizen",
      identityVerified: false,
    });
    expect(first.headers["set-cookie"]).toBeUndefined();
    await agent.post(`/test/device/${payload.deviceId}`);

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
    expect(fsMock.bindBadgeDeviceAtomic).toHaveBeenCalledWith(
      "verified-session-badge",
      "badge-integration-device",
      expect.any(String)
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

    // An enrolled device still cannot claim a badge bound elsewhere.
    const payload = buildHeartbeatPayload("attacker-device-2", { lat: 36.75, lng: 7.6 });
    await agent.post(`/test/device/${payload.deviceId}`);
    const second = await agent.post("/api/location/heartbeat").send(payload);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ role: "citizen", identityVerified: false, badgeBoundToDevice: true });
    // The lock must NOT have been re-written to the attacker's device.
    expect(fsMock.docUpdate).not.toHaveBeenCalled();
    expect(fsMock.badgeOwner).toBeNull();
  });

  it("an unauthenticated heartbeat cannot overwrite a tracked responder location", async () => {
    setReporterBadge("verified-session-badge");
    const payload = buildHeartbeatPayload("tracked-responder-device", { lat: 36.75, lng: 7.6 });
    const agent = supertest.agent(createApp());

    await agent.post(`/test/device/${payload.deviceId}`);
    const verified = await agent.post("/api/location/heartbeat").send(payload);
    expect(verified.body.identityVerified).toBe(true);

    vi.advanceTimersByTime(3100);
    const app = createApp();
    const attacker = await supertest(app)
      .post("/api/location/heartbeat")
      .send({ deviceId: payload.deviceId, lat: 0, lng: 0, name: "Impersonator" });
    expect(attacker.status).toBe(403);

    const adminToken = (await import("../server/middleware.js")).generateAdminToken();
    const locations = await supertest(app).get("/api/locations").set("Cookie", `admin_token=${adminToken}`);
    expect(locations.body.find((entry: any) => entry.deviceId === payload.deviceId)).toMatchObject({
      lat: 36.75,
      lng: 7.6,
      identityVerified: true,
    });

    vi.advanceTimersByTime(3100);
    const legitimate = await agent.post("/api/location/heartbeat")
      .send({ ...payload, lat: 36.76, lng: 7.61 });
    expect(legitimate.status).toBe(200);
    expect(legitimate.body.identityVerified).toBe(true);
  });

  it("only one concurrent device can win a first badge binding", async () => {
    setReporterBadge("verified-session-badge");
    const app = createApp();
    const firstDevice = supertest.agent(app);
    const secondDevice = supertest.agent(app);
    const firstPayload = buildHeartbeatPayload("concurrent-device-a", { lat: 36.75, lng: 7.6 });
    const secondPayload = buildHeartbeatPayload("concurrent-device-b", { lat: 36.75, lng: 7.6 });

    await firstDevice.post(`/test/device/${firstPayload.deviceId}`);
    await secondDevice.post(`/test/device/${secondPayload.deviceId}`);

    // Both collection reads see the same stale, unbound snapshot.
    const [snapshot] = (await fsMock.collectionGet("badgeCodes"))!;
    fsMock.collectionGet.mockImplementation(async () => [{ ...snapshot }]);
    const [first, second] = await Promise.all([
      firstDevice.post("/api/location/heartbeat").send(firstPayload),
      secondDevice.post("/api/location/heartbeat").send(secondPayload),
    ]);
    expect([first.body.identityVerified, second.body.identityVerified].filter(Boolean)).toHaveLength(1);
  });
});
