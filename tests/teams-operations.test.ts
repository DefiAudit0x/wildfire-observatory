import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
import { generateAdminToken } from "../server/middleware.js";
import { createTeamMemberToken } from "../server/teamAuth.js";

/**
 * Team Mode — live operations: heartbeat streaming, positions readout, leave,
 * mission phase and team CRUD. The registry (server/teamRegistry.ts) is REAL
 * here — only the Firestore boundary is mocked — so TTL/throttle logic is
 * exercised end to end.
 *
 * Isolation notes:
 *  - The IP rate limiters are module-level and shared by every test in the
 *    file, so each request carries a UNIQUE X-Forwarded-For (house pattern:
 *    trust proxy 1 + per-test XFF, see AGENTS.md).
 *  - The 3s per-member minimum interval is keyed by memberId, so each test
 *    uses its own member id.
 */

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async (..._a: any[]) => [] as any),
  docGet: vi.fn(async (..._a: any[]) => null as any),
  docSet: vi.fn(async (..._a: any[]) => true as any),
  docUpdate: vi.fn(async (..._a: any[]) => true as any),
  invalidateCollectionCache: vi.fn(),
  invalidateDocCache: vi.fn(),
}));

const atomicMock = vi.hoisted(() => ({
  joinTeamAtomically: vi.fn(async (..._a: any[]) => ({ status: "joined", member: {} }) as any),
  setMissionPhaseAtomically: vi.fn(async (..._a: any[]) => ({ status: "updated", mission: { sosId: "sos-1", phase: "on_scene" } }) as any),
}));

vi.mock("../server/fs.js", () => fsMock);
vi.mock("../server/atomic.js", () => atomicMock);

import teamsRouter from "../server/routes/teams.js";
import { clearRegistry, listPositions } from "../server/teamRegistry.js";

let ipCounter = 0;
function createApp() {
  ipCounter = 0;
  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/teams", teamsRouter);
  return app;
}

/** Unique per-request IP bucket → rate limiters never bleed between tests. */
function nextIp() {
  ipCounter += 1;
  return { "X-Forwarded-For": `10.77.${ipCounter}.9` };
}

const adminAuth = () => ({ authorization: `Bearer ${generateAdminToken()}` });
const memberAuth = (memberId: string, teamId = "team-a1") => ({
  authorization: `Bearer ${createTeamMemberToken(memberId, teamId)}`,
});

function memberFixture(memberId: string) {
  return { memberId, teamId: "team-a1", name: `عضو ${memberId}`, active: true };
}

beforeEach(() => {
  clearRegistry();
  fsMock.collectionGet.mockReset().mockResolvedValue([]);
  fsMock.docGet.mockReset().mockResolvedValue(null);
  fsMock.docSet.mockReset().mockResolvedValue(true);
  fsMock.docUpdate.mockReset().mockResolvedValue(true);
  atomicMock.setMissionPhaseAtomically.mockReset().mockResolvedValue({ status: "updated", mission: {} });
});

function heartbeatableMocks(memberId: string) {
  fsMock.docGet.mockImplementation(async (collection: string) => {
    if (collection === "teamMembers") return memberFixture(memberId);
    if (collection === "teams") return { teamId: "team-a1", name: "Unité 1", nameAr: "وحدة 1", type: "protection_civile", active: true };
    if (collection === "teamMissions") return { teamId: "team-a1", sosId: "sos-77", phase: "en_route", since: 1000 };
    return null;
  });
}

describe("POST /api/teams/heartbeat", () => {
  it("accepts a valid heartbeat, returns the mission and stores the live position", async () => {
    heartbeatableMocks("tm-hb1");
    const res = await supertest(createApp())
      .post("/api/teams/heartbeat")
      .set(memberAuth("tm-hb1"))
      .set(nextIp())
      .send({ lat: 36.75, lng: 5.07, accuracy: 12, speed: 8.3, batteryPct: 77 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.heartbeatIntervalMs).toBe(15000);
    expect(res.body.mission).toEqual({ sosId: "sos-77", phase: "en_route", since: 1000 });

    const live = listPositions({ teamId: "team-a1" });
    expect(live).toHaveLength(1);
    expect(live[0].lat).toBeCloseTo(36.75);
    expect(live[0].batteryPct).toBe(77);
    expect(live[0].trail.length).toBeGreaterThan(0);
  });

  it("401 without a team token, 400 for out-of-coverage coordinates", async () => {
    heartbeatableMocks("tm-hb2");
    const app = createApp();
    expect((await supertest(app).post("/api/teams/heartbeat").set(nextIp()).send({ lat: 36.7, lng: 5.0 })).status).toBe(401);
    expect((await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-hb2")).set(nextIp()).send({ lat: 51.5, lng: -0.1 })).status).toBe(400);
  });

  it("403 when membership is missing, cross-team, deactivated, or the team is dead", async () => {
    const app = createApp();
    // missing member
    expect((await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-missing")).set(nextIp()).send({ lat: 36.7, lng: 5.0 })).status).toBe(403);

    // member from another team (token/teamId mismatch)
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-cross"), teamId: "team-OTHER" };
      return null;
    });
    expect((await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-cross")).set(nextIp()).send({ lat: 36.7, lng: 5.0 })).status).toBe(403);

    // deactivated member
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-off"), active: false };
      if (collection === "teams") return { teamId: "team-a1", active: true };
      return null;
    });
    const inactive = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-off")).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(inactive.status).toBe(403);
    expect(inactive.body.code).toBe("MEMBER_INACTIVE");

    // deactivated team
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return memberFixture("tm-deadteam");
      if (collection === "teams") return { teamId: "team-a1", active: false };
      return null;
    });
    const deadTeam = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-deadteam")).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(deadTeam.status).toBe(403);
    expect(deadTeam.body.code).toBe("TEAM_INACTIVE");
  });

  it("rejects a heartbeat storm (429 within the 3s per-member window)", async () => {
    heartbeatableMocks("tm-storm");
    const app = createApp();
    const first = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-storm")).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(first.status).toBe(200);
    const second = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-storm")).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(second.status).toBe(429);
    // A DIFFERENT member is unaffected by the first member's window.
    const other = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-storm2")).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(other.status).toBe(200);
  });

  it("maintains a bounded trail and rejects absurd payloads", async () => {
    heartbeatableMocks("tm-payload");
    const app = createApp();
    expect((await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-payload")).set(nextIp()).send({ lat: 36.7, lng: 5.0, batteryPct: 500 })).status).toBe(400);
    expect((await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-payload")).set(nextIp()).send({ lat: 91, lng: 5.0 })).status).toBe(400);
  });
});

describe("POST /api/teams/leave", () => {
  it("deactivates the membership and removes the live position", async () => {
    heartbeatableMocks("tm-leave");
    const app = createApp();
    const hb = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-leave")).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(hb.status).toBe(200);
    expect(listPositions()).toHaveLength(1);

    const res = await supertest(app).post("/api/teams/leave").set(memberAuth("tm-leave")).set(nextIp());
    expect(res.status).toBe(200);
    expect(listPositions()).toHaveLength(0);
    expect(fsMock.docUpdate).toHaveBeenCalledWith("teamMembers", "tm-leave", expect.objectContaining({ active: false }));
  });

  it("401 without token, 403 for foreign membership", async () => {
    const app = createApp();
    expect((await supertest(app).post("/api/teams/leave").set(nextIp())).status).toBe(401);
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-foreign"), teamId: "team-OTHER" };
      return null;
    });
    expect((await supertest(app).post("/api/teams/leave").set(memberAuth("tm-foreign")).set(nextIp())).status).toBe(403);
  });
});

describe("POST /api/teams/mission/phase", () => {
  it("updates the phase via the atomic helper and 409s without an active mission", async () => {
    const app = createApp();
    const ok = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-phase")).set(nextIp()).send({ phase: "on_scene" });
    expect(ok.status).toBe(200);
    const [calledTeamId, calledPhase] = atomicMock.setMissionPhaseAtomically.mock.calls[0];
    expect(calledTeamId).toBe("team-a1");
    expect(calledPhase).toBe("on_scene");
    expect(fsMock.invalidateDocCache).toHaveBeenCalledWith("teamMissions", "team-a1");

    atomicMock.setMissionPhaseAtomically.mockResolvedValueOnce({ status: "no-active-mission" });
    const none = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-phase")).set(nextIp()).send({ phase: "on_scene" });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe("NO_ACTIVE_MISSION");
  });

  it("401 without token and 400 for phases other than on_scene (clear stays admin-only)", async () => {
    const app = createApp();
    expect((await supertest(app).post("/api/teams/mission/phase").set(nextIp()).send({ phase: "on_scene" })).status).toBe(401);
    expect((await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-phase2")).set(nextIp()).send({ phase: "cleared" })).status).toBe(400);
  });
});

describe("POST /api/teams — team registration", () => {
  it("creates a team with a server-generated id and defaults", async () => {
    const res = await supertest(createApp())
      .post("/api/teams")
      .set(adminAuth())
      .send({ name: "Unité Béjaïa", nameAr: "وحدة بجاية", type: "protection_civile", baseLat: 36.75, baseLng: 5.07 });
    expect(res.status).toBe(201);
    expect(res.body.teamId).toMatch(/^team-[0-9a-f]{8}$/);
    expect(res.body.active).toBe(true);
    expect(fsMock.docSet).toHaveBeenCalledWith("teams", res.body.teamId, expect.objectContaining({ name: "Unité Béjaïa" }));
  });

  it("400 for invalid type, bad names, or out-of-coverage base coordinates", async () => {
    const app = createApp();
    const send = (body: Record<string, unknown>) =>
      supertest(app).post("/api/teams").set(adminAuth()).send(body);
    expect((await send({ name: "X", nameAr: "وحدة", type: "protection_civile" })).status).toBe(400);
    expect((await send({ name: "Unité", nameAr: "وحدة", type: "police" })).status).toBe(400);
    expect((await send({ name: "Unité", nameAr: "وحدة", type: "volunteers", baseLat: 51.5, baseLng: 5.07 })).status).toBe(400);
    expect((await send({ name: "Unité", nameAr: "وحدة", type: "volunteers", baseLat: 36.7 })).status).toBe(400); // lng missing
  });

  it("503 when storage is down and 401 when unauthenticated", async () => {
    fsMock.docSet.mockResolvedValueOnce(false);
    expect(
      (
        await supertest(createApp())
          .post("/api/teams")
          .set(adminAuth())
          .send({ name: "Unité", nameAr: "وحدة", type: "volunteers" })
      ).status
    ).toBe(503);
    expect((await supertest(createApp()).post("/api/teams").send({ name: "Unité", nameAr: "وحدة", type: "volunteers" })).status).toBe(401);
  });
});

describe("GET /api/teams — command-center roster", () => {
  it("merges teams, live positions, trails and active missions; hides deactivated teams", async () => {
    fsMock.collectionGet.mockImplementation(async (collection: string) => {
      if (collection === "teams")
        return [
          { teamId: "team-a1", name: "Unité 1", nameAr: "وحدة 1", type: "protection_civile", active: true },
          { teamId: "team-dead", name: "Gone", nameAr: "منحل", type: "volunteers", active: false },
        ];
      if (collection === "teamMembers")
        return [
          { memberId: "tm-roster", teamId: "team-a1", name: "فريق الجبل", active: true, joinedAt: 111 },
          { memberId: "tm-quitter", teamId: "team-a1", name: "منسحب", active: false },
          { memberId: "tm-far", teamId: "team-b2", name: "بعيد", active: true },
        ];
      return [];
    });
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return memberFixture("tm-roster");
      if (collection === "teams") return { teamId: "team-a1", active: true };
      if (collection === "teamMissions") return { teamId: "team-a1", sosId: "sos-77", phase: "en_route", since: 1000 };
      return null;
    });

    const app = createApp();
    const hb1 = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-roster")).set(nextIp()).send({ lat: 36.751, lng: 5.071, accuracy: 9 });
    expect(hb1.status).toBe(200);
    await new Promise((r) => setTimeout(r, 3100)); // clear the per-member min-interval window
    const hb2 = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-roster")).set(nextIp()).send({ lat: 36.755, lng: 5.075 });
    expect(hb2.status).toBe(200);

    const res = await supertest(app).get("/api/teams").set(adminAuth()).set(nextIp());
    expect(res.status).toBe(200);
    const teams = res.body;
    expect(teams).toHaveLength(1); // deactivated team hidden
    const team = teams[0];
    expect(team.teamId).toBe("team-a1");
    expect(team.members).toHaveLength(1); // quitter filtered out
    const member = team.members[0];
    expect(member.online).toBe(true);
    expect(member.lat).toBeCloseTo(36.755);
    expect(member.trail.length).toBe(2); // two heartbeats, second moved > 20 m
    expect(team.activeMission).toEqual({ sosId: "sos-77", phase: "en_route", since: 1000 });
  });

  it("marks members offline without a live position and reports last-known coords", async () => {
    fsMock.collectionGet.mockImplementation(async (collection: string) => {
      if (collection === "teams") return [{ teamId: "team-a1", name: "U", nameAr: "و", type: "volunteers", active: true }];
      if (collection === "teamMembers")
        return [{ memberId: "tm-old", teamId: "team-a1", name: "قديم", active: true, lastKnownLat: 36.5, lastKnownLng: 5.0, lastSeenAt: Date.now() - 3_600_000 }];
      return [];
    });
    fsMock.docGet.mockResolvedValue(null);
    const res = await supertest(createApp()).get("/api/teams").set(adminAuth()).set(nextIp());
    expect(res.status).toBe(200);
    const member = res.body[0].members[0];
    expect(member.online).toBe(false);
    expect(member.lat).toBeCloseTo(36.5);
    expect(member.trail).toEqual([]);
  });

  it("requires admin", async () => {
    expect((await supertest(createApp()).get("/api/teams").set(nextIp())).status).toBe(401);
  });
});
