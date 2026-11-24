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
  // The IP-level flood limiter (S-H3) lives at MODULE scope; trust-proxy +
  // a unique X-Forwarded-For per admission call (postSos below) keeps every
  // test in its own address bucket so the suite tests each limiter in turn.
  app.set("trust proxy", 1);
  app.use(cookieParser());
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/sos", sosRouter);
  return app;
}

let xffCounter = 0;
function postSos(app: ReturnType<typeof createApp>, ip?: string) {
  xffCounter += 1;
  const addr = ip ?? `10.77.0.${(xffCounter % 250) + 1}`;
  return supertest(app).post("/api/sos").set("X-Forwarded-For", addr);
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
    const res = await postSos(app).send(validBody());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body.status).toBe("active");
    expect(res.body.priority).toBeDefined();
  });

  it("returns 400 for missing required fields", async () => {
    const app = createApp();
    const res = await postSos(app).send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for coordinates outside coverage (North Africa geofence)", async () => {
    const app = createApp();
    const res = await postSos(app).send({
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
    const first = await postSos(app).send(body);
    expect(first.status).toBe(200);
    const second = await postSos(app).send(body);
    expect(second.status).toBe(409);
  });

  it("does not claim success or consume duplicate capacity when durable SOS storage fails", async () => {
    const app = createApp();
    const body = validBody();
    fsMock.createSosWithAdmission.mockResolvedValueOnce("unavailable").mockResolvedValueOnce("created");

    const failed = await postSos(app).send(body);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("SOS_STORAGE_UNAVAILABLE");

    const retry = await postSos(app).send(body);
    expect(retry.status).toBe(200);
    expect(fsMock.createSosWithAdmission).toHaveBeenCalledTimes(2);
  });

  it("clamps audioDuration to the configured maximum", async () => {
    const app = createApp();
    const res = await postSos(app).send({
      ...validBody(),
      audioDuration: 999,
    });
    expect(res.status).toBe(200);
    expect(res.body.audioDuration).toBeLessThanOrEqual(20);
  });

  it("caps oversized audio payloads", async () => {
    const app = createApp();
    const bigAudio = `data:audio/webm;base64,${"a".repeat(800 * 1024)}`;
    const res = await postSos(app).send({
      ...validBody(),
      audioUrl: bigAudio,
    });
    expect(res.status).toBe(400);
  });

  it("exposes metadata (priority, nearby-fire corroboration) on successful SOS", async () => {
    const app = createApp();
    const res = await postSos(app).send(validBody());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("priority");
    expect(res.body).toHaveProperty("nearbyFireCorroborated");
    expect(res.body).toHaveProperty("nearestFireDistanceKm");
  });

  it("does not leak raw audio in the POST response (only a hasAudio flag)", async () => {
    const app = createApp();
    const res = await postSos(app).send({
      ...validBody(),
      audioUrl: "data:audio/webm;base64,AAAA",
    });
    expect(res.status).toBe(200);
    expect(res.body.audioUrl).toBeUndefined();
    expect(res.body.hasAudio).toBe(true);
  });

  it("does not leak PII on the public list endpoint (audio, phone, deviceId stripped)", async () => {
    const app = createApp();
    await postSos(app).send({
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
    await postSos(app).send(validBody());
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
      const res = await postSos(app).send({ ...validBody(), deviceId: limiterDevice });
      if (res.status === 429) got429 = true;
    }
    expect(got429).toBe(true);
  });
});

describe("SOS durable lifecycle mutations", () => {
  const adminAuth = () => ({ authorization: `Bearer ${generateAdminToken()}` });

  it("B4: resolve runs the atomic tx and surfaces the cleared-mission count", async () => {
    const app = createApp();
    const created = await postSos(app).send(validBody());
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
    const created = await postSos(app).send(validBody());
    fsMock.resolveSosAtomically.mockResolvedValueOnce({ status: "missing" });

    const resolve = await supertest(app)
      .post(`/api/sos/${created.body.id}/resolve`)
      .set(adminAuth());

    expect(resolve.status).toBe(404);
  });

  it("does not claim resolve success when durable update fails", async () => {
    const app = createApp();
    const created = await postSos(app).send(validBody());
    fsMock.resolveSosAtomically.mockResolvedValueOnce({ status: "unavailable" });

    const resolve = await supertest(app)
      .post(`/api/sos/${created.body.id}/resolve`)
      .set(adminAuth());

    expect(resolve.status).toBe(503);
    expect(resolve.body.code).toBe("SOS_STORAGE_UNAVAILABLE");
  });

  it("Fix 43 (SOS-6): a re-dispatch returns the original dispatch with alreadyDispatched — no duplicate in the fallback record", async () => {
    const app = createApp();
    const created = await postSos(app).send(validBody());
    const team = { teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true };
    fsMock.docGet.mockResolvedValueOnce(team).mockResolvedValueOnce(team);
    fsMock.appendSosDispatch.mockResolvedValueOnce("ok").mockResolvedValueOnce("already_dispatched");

    const first = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "" });
    expect(first.status).toBe(200);
    expect(first.body.alreadyDispatched).toBeUndefined();

    const second = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "" });
    expect(second.status).toBe(200);
    expect(second.body.alreadyDispatched).toBe(true);
    expect(second.body.dispatch.teamId).toBe("team-alpha");
    expect(second.body.dispatch.dispatchedAt).toBe(first.body.dispatch.dispatchedAt);

    const record = await supertest(app).get(`/api/sos/${created.body.id}`).set(adminAuth());
    expect(record.status).toBe(200);
    expect(record.body.dispatchedTeams).toHaveLength(1);
  });

  it("Fix 43b: a repeat dispatch after clear + re-dispatch returns the NEWEST stored dispatch, not the superseded first one", async () => {
    const app = createApp();
    const created = await postSos(app).send(validBody());
    const team = { teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true };
    fsMock.docGet.mockResolvedValueOnce(team).mockResolvedValueOnce(team).mockResolvedValueOnce(team);
    fsMock.appendSosDispatch.mockResolvedValueOnce("ok").mockResolvedValueOnce("ok").mockResolvedValueOnce("already_dispatched");

    const first = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "first" });
    expect(first.status).toBe(200);
    const second = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "second" });
    expect(second.status).toBe(200);
    // The memory fallback now holds two entries for the same team (clear +
    // re-dispatch appends a second one); the repeat dispatch must return
    // the newest, not the first.
    const third = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "third" });
    expect(third.status).toBe(200);
    expect(third.body.alreadyDispatched).toBe(true);
    expect(third.body.dispatch.notes).toBe("second");
    expect(third.body.dispatch.dispatchedAt).toBe(second.body.dispatch.dispatchedAt);
  });

  it("Fix 43b: a repeat dispatch after a process restart returns the durable stored dispatch, not a freshly built one", async () => {
    const app = createApp();
    // No POST /api/sos here on purpose: the process restarted, so
    // memorySos lacks this SOS entirely. The durable doc is the only
    // source of the original dispatch.
    const team = { teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true };
    const stored = {
      id: "sos-restart-1",
      dispatchedTeams: [
        { teamId: "team-alpha", type: "protection_civile", teamNameAr: "فريق ألفا", teamNameFr: "Team Alpha", dispatchedAt: "2026-11-24T10:00:00.000Z", status: "en_route", notes: "original-notes" },
      ],
    };
    fsMock.docGet.mockResolvedValueOnce(team).mockResolvedValueOnce(stored);
    fsMock.appendSosDispatch.mockResolvedValueOnce("already_dispatched");

    const repeat = await supertest(app)
      .post("/api/sos/sos-restart-1/dispatch")
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "retry-notes" });
    expect(repeat.status).toBe(200);
    expect(repeat.body.alreadyDispatched).toBe(true);
    expect(repeat.body.dispatch.notes).toBe("original-notes");
    expect(repeat.body.dispatch.dispatchedAt).toBe("2026-11-24T10:00:00.000Z");
  });

  it("does not claim dispatch success when durable update fails", async () => {
    const app = createApp();
    const created = await postSos(app).send(validBody());
    fsMock.docGet.mockResolvedValueOnce({ teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true });
    fsMock.appendSosDispatch.mockResolvedValueOnce("unavailable");

    const dispatch = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "" });

    expect(dispatch.status).toBe(503);
    expect(dispatch.body.code).toBe("SOS_STORAGE_UNAVAILABLE");
  });

  it("S-M7: rejects dispatch notes over 500 chars before anything durable happens", async () => {
    const app = createApp();
    const created = await postSos(app).send(validBody());

    const dispatch = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "x".repeat(501) });

    expect(dispatch.status).toBe(400);
    // Validation is the FIRST gate — no team lookup, no dispatch write.
    expect(fsMock.docGet).not.toHaveBeenCalled();
    expect(fsMock.appendSosDispatch).not.toHaveBeenCalled();
  });

  it("S-M7: accepts dispatch notes at the 500-char cap", async () => {
    const app = createApp();
    const created = await postSos(app).send(validBody());
    fsMock.docGet.mockResolvedValueOnce({ teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true });
    fsMock.appendSosDispatch.mockResolvedValueOnce("ok");

    const dispatch = await supertest(app)
      .post(`/api/sos/${created.body.id}/dispatch`)
      .set(adminAuth())
      .send({ teamId: "team-alpha", notes: "y".repeat(500) });

    expect(dispatch.status).toBe(200);
  });

  it("rejects dispatching to a resolved SOS with 409 (atomic transaction guard)", async () => {
    const app = createApp();
    const created = await postSos(app).send(validBody());
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
    const created = await postSos(app).send(validBody());
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
    const created = await postSos(app).send(validBody());
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
    const created = await postSos(app).send(validBody());
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
  const contact = { name: "علي", phone: "0550123456" };

  it("returns an empty profile for an enrolled browser without contact details", async () => {
    const agent = supertest.agent(createApp());
    await agent.post("/api/sos/profile").set("Sec-Fetch-Site", "same-origin").send({}).expect(200);
    await agent.get("/api/sos/profile/current").expect(200, { name: "", phone: "" });
  });

  it("stores a profile and returns it back (encrypted-at-rest on server)", async () => {
    const agent = supertest.agent(createApp());
    const enrollment = await agent.post("/api/sos/profile").set("Sec-Fetch-Site", "same-origin").send(contact).expect(200);
    expect(enrollment.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    const stored = fsMock.docSet.mock.calls[0][2];
    expect(stored.encrypted).toEqual(expect.any(String));
    expect(JSON.stringify(stored)).not.toContain(contact.phone);
    await agent.get("/api/sos/profile/current").expect(200, contact);

    const updated = { ...contact, name: "Updated" };
    await agent.put("/api/sos/profile/current").send(updated).expect(200);
    await agent.get("/api/sos/profile/current").expect(200, updated);
  });

  it("does not report successful profile storage when the durable write fails", async () => {
    const agent = supertest.agent(createApp());
    await agent.post("/api/sos/profile").set("Sec-Fetch-Site", "same-origin").send({}).expect(200);
    fsMock.docSet.mockResolvedValueOnce(false);
    await agent.put("/api/sos/profile/current").send(contact).expect(503);
    await agent.get("/api/sos/profile/current").expect(200, { name: "", phone: "" });
  });

  it("validates profile inputs", async () => {
    const agent = supertest.agent(createApp());
    await agent.post("/api/sos/profile").set("Sec-Fetch-Site", "same-origin").send({}).expect(200);
    await agent.put("/api/sos/profile/current").send({ name: "x".repeat(500) }).expect(400);
  });

  it("rejects a profile request for another device after the browser is bound", async () => {
    const agent = supertest.agent(createApp());
    await agent.post("/api/sos/profile").set("Sec-Fetch-Site", "same-origin").send(contact).expect(200);
    const mismatch = await agent.get(`/api/sos/profile/${uniqueDevice()}`);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toContain("mismatch");
  });

  it("rejects cross-origin enrollment with 403 and stores nothing (Fix 2b, CWE-352)", async () => {
    const agent = supertest.agent(createApp());
    const res = await agent
      .post("/api/sos/profile")
      .set("Origin", "https://evil.example")
      .set("Sec-Fetch-Site", "cross-site")
      .send(contact);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("cross-origin");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(fsMock.docSet).not.toHaveBeenCalled();
  });

  it("rejects enrollment with no origin signal (Fix 2b)", async () => {
    const agent = supertest.agent(createApp());
    const res = await agent.post("/api/sos/profile").send(contact);
    expect(res.status).toBe(403);
    expect(fsMock.docSet).not.toHaveBeenCalled();
  });
});

it("SOS-1 keeps submitted text in the staff SOS response only", async () => {
  const app = createApp();
  const body = { ...validBody(), lat: 36.7543, lng: 7.6021, textMessage: "Training message" };
  const created = await postSos(app).send(body).expect(200);
  const publicList = await supertest(app).get("/api/sos").expect(200);
  const entry = publicList.body.find((item: { id: string }) => item.id === created.body.id);
  expect(entry).toMatchObject({ lat: 36.75, lng: 7.6 });
  expect(entry).not.toHaveProperty("textMessage");
  const staff = await supertest(app).get(`/api/sos/${created.body.id}`)
    .set("Cookie", `admin_token=${generateAdminToken()}`).expect(200);
  expect(staff.body).toMatchObject(body);
});

describe("POST /api/sos — F4 clientGeneratedId idempotency", () => {
  function sosBody(cgid?: string) {
    return { ...validBody(), clientGeneratedId: cgid };
  }

  it("rejects a clientGeneratedId shorter than the schema floor", async () => {
    const app = createApp();
    const res = await postSos(app).send(sosBody("short"));
    expect(res.status).toBe(400);
  });

  it("replays the FIRST stored SOS when the same clientGeneratedId is retried in-process", async () => {
    const app = createApp();
    const cgid = "cg-sos-retry-0001";

    const body = sosBody(cgid);
    const first = await postSos(app).send(body);
    expect(first.status).toBe(200);
    const firstId = first.body.id;

    const retry = await postSos(app).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ id: firstId, status: "active" });

    // exactly ONE durable admission happened for the pair of requests
    expect(fsMock.createSosWithAdmission).toHaveBeenCalledTimes(1);
  });

  it("rejects a retry key replayed from a DIFFERENT device with 409", async () => {
    const app = createApp();
    const cgid = "cg-sos-retry-0004";

    const first = await postSos(app).send({ ...sosBody(cgid), deviceId: "dev-first" });
    expect(first.status).toBe(200);

    const retry = await postSos(app).send({ ...sosBody(cgid), deviceId: "dev-second" });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/different device/i);

    // the rejected replay must not admit a second SOS
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
    const res = await postSos(app).send({ ...sosBody(cgid), deviceId: "dev-x" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "sos-durable-42", status: "pending" });
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
    const res = await postSos(app).send(sosBody(cgid));
    expect(res.status).toBe(200);
    expect(fsMock.createSosWithAdmission).toHaveBeenCalledTimes(1);
    // v2.15.0: the replay key rides INSIDE the admission transaction (6th
    // arg) — no separate best-effort docSet that could be skipped by a
    // crash, leaving an admitted SOS without its dedupe key.
    const admissionArgs = fsMock.createSosWithAdmission.mock.calls[0];
    expect(admissionArgs[5]).toEqual(
      expect.objectContaining({
        collection: "sosIdempotency",
        key: cgid,
        record: expect.objectContaining({ sosId: res.body.id }),
      }),
    );
  });

  it("distinct clientGeneratedIds create distinct SOS calls", async () => {
    const app = createApp();
    const a = await postSos(app).send(sosBody("cg-sos-distinct-a"));
    const b = await postSos(app).send(sosBody("cg-sos-distinct-b"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).not.toBe(b.body.id);
    expect(fsMock.createSosWithAdmission).toHaveBeenCalledTimes(2);
  });
});

describe("v2.15.0 — honest no-fix SOS + NaN hardening", () => {
  it("accepts an SOS with NULL coordinates when the device has no GPS fix — no proximity math is fabricated", async () => {
    const app = createApp();
    const res = await postSos(app).send({
      deviceId: uniqueDevice(),
      lat: null,
      lng: null,
      hasLocation: false,
      textMessage: "لا يوجد GPS — أرسل بدون موقع",
    });
    expect(res.status).toBe(200);
    expect(res.body.hasLocation).toBe(false);
    expect(res.body.lat).toBeNull();
    expect(res.body.lng).toBeNull();
    // No fake Algiers-derived priority/corroboration: unknown means unknown.
    expect(res.body.priority).toBe("unknown");
    expect(res.body.nearestFireDistanceKm).toBeNull();
    expect(res.body.nearbyFireCorroborated).toBe(false);
  });

  it("Fix 43 (SOS-5): the public feed preserves null coordinates for a no-fix SOS — no fabricated 0,0", async () => {
    const app = createApp();
    const created = await postSos(app).send({
      deviceId: uniqueDevice(),
      lat: null,
      lng: null,
      hasLocation: false,
      textMessage: "لا يوجد GPS — أرسل بدون موقع",
    });
    expect(created.status).toBe(200);
    const feed = await supertest(app).get("/api/sos");
    expect(feed.status).toBe(200);
    const item = feed.body.find((s: any) => s.id === created.body.id);
    expect(item).toBeDefined();
    expect(item.lat).toBeNull();
    expect(item.lng).toBeNull();
    expect(item.hasLocation).toBe(false);
    // A located SOS on the same feed is still rounded, not nulled.
    const located = await postSos(app).send(validBody());
    const feed2 = await supertest(app).get("/api/sos");
    const locatedItem = feed2.body.find((s: any) => s.id === located.body.id);
    expect(locatedItem.lat).toBe(36.75);
    expect(locatedItem.lng).toBe(7.6);
  });

  it("still geofences SOS when coordinates ARE provided", async () => {
    const app = createApp();
    const res = await postSos(app).send({
      deviceId: uniqueDevice(),
      lat: 51.5,
      lng: -0.12,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("monitoring coverage");
  });

  it("400s a non-numeric audioDuration instead of persisting NaN", async () => {
    const app = createApp();
    const res = await postSos(app).send({
      deviceId: uniqueDevice(),
      lat: 36.75,
      lng: 7.6,
      audioDuration: "NaN",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("audioDuration");
  });

  it("keeps the pinned numeric clamp: 999 seconds → ≤20", async () => {
    const app = createApp();
    const res = await postSos(app).send({
      deviceId: uniqueDevice(),
      lat: 36.75,
      lng: 7.6,
      audioDuration: 999,
    });
    expect(res.status).toBe(200);
    expect(res.body.audioDuration).toBeLessThanOrEqual(20);
    expect(res.body.audioDuration).toBeGreaterThanOrEqual(1);
  });
});
