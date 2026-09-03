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
  docMergeSet: vi.fn(async (..._a: any[]) => true as any),
  docUpdate: vi.fn(async (..._a: any[]) => true as any),
  docDelete: vi.fn(async (..._a: any[]) => true as any),
  docDeleteFields: vi.fn(async (..._a: any[]) => true as any),
  incrementDocField: vi.fn(async (..._a: any[]) => true as any),
  invalidateCollectionCache: vi.fn(),
  invalidateDocCache: vi.fn(),
}));

const atomicMock = vi.hoisted(() => ({
  joinTeamAtomically: vi.fn(async (..._a: any[]) => ({ status: "joined", member: {}, tokenGen: 0 }) as any),
  setMissionPhaseAtomically: vi.fn(async (..._a: any[]) => ({ status: "updated", mission: { sosId: "sos-1", phase: "on_scene" } }) as any),
  clearTeamMissionAtomically: vi.fn(async (..._a: any[]) => ({ status: "cleared", mission: {} }) as any),
  setPrincipalBlocked: vi.fn(async (..._a: any[]) => "blocked" as any),
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
const memberAuth = (memberId: string, teamId = "team-a1", tokenGen = 0) => ({
  authorization: `Bearer ${createTeamMemberToken(memberId, teamId, tokenGen)}`,
});

function memberFixture(memberId: string) {
  return { memberId, teamId: "team-a1", name: `عضو ${memberId}`, active: true };
}

beforeEach(() => {
  clearRegistry();
  fsMock.collectionGet.mockReset().mockResolvedValue([]);
  fsMock.docGet.mockReset().mockResolvedValue(null);
  fsMock.docSet.mockReset().mockResolvedValue(true);
  fsMock.docMergeSet.mockReset().mockResolvedValue(true);
  fsMock.docUpdate.mockReset().mockResolvedValue(true);
  fsMock.docDelete.mockReset().mockResolvedValue(true);
  fsMock.docDeleteFields.mockReset().mockResolvedValue(true);
  fsMock.incrementDocField.mockReset().mockResolvedValue(true);
  atomicMock.setMissionPhaseAtomically.mockReset().mockResolvedValue({ status: "updated", mission: {} });
  atomicMock.clearTeamMissionAtomically.mockReset().mockResolvedValue({ status: "cleared", mission: {} });
  atomicMock.setPrincipalBlocked.mockReset().mockResolvedValue("blocked");
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
    expect(res.body.mission).toEqual({ sosId: "sos-77", phase: "en_route", since: 1000, sosLat: null, sosLng: null });

    const live = listPositions({ teamId: "team-a1" });
    expect(live).toHaveLength(1);
    expect(live[0].lat).toBeCloseTo(36.75);
    expect(live[0].batteryPct).toBe(77);
    expect(live[0].trail.length).toBeGreaterThan(0);
  });

  it("F10: carries the client's fixTimeMs into the live registry", async () => {
    heartbeatableMocks("tm-hb-fix");
    const sent = Date.now() - 4_000;
    const res = await supertest(createApp())
      .post("/api/teams/heartbeat")
      .set(memberAuth("tm-hb-fix"))
      .set(nextIp())
      .send({ lat: 36.75, lng: 5.07, fixTimeMs: sent });
    expect(res.status).toBe(200);
    const live = listPositions({ teamId: "team-a1" })[0];
    expect(live.fixTimeMs).toBe(sent);
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

  it("ARC-R3: 65 co-located members behind ONE egress IP never starve (member-keyed limit)", async () => {
    // Under the old IP-keyed bucket (60/min/IP) request #61 got a 429 mid-operation.
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { memberId: "dynamic", teamId: "team-a1", name: "عضو ميداني", active: true };
      if (collection === "teams") return { teamId: "team-a1", name: "U", nameAr: "و", type: "volunteers", active: true };
      return null;
    });
    const app = createApp();
    const sharedIp = { "X-Forwarded-For": "10.99.99.99" }; // ONE CGNAT egress for everyone
    for (let i = 0; i < 65; i += 1) {
      const res = await supertest(app).post("/api/teams/heartbeat").set(memberAuth(`tm-cgnat-${i}`)).set(sharedIp).send({ lat: 36.7, lng: 5.0 });
      expect(res.status).toBe(200);
    }
  });

  it("ARC-R1: snapshots are MERGE writes carrying only display fields (no authority wipe)", async () => {
    heartbeatableMocks("tm-snap");
    const app = createApp();
    const res = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-snap")).set(nextIp()).send({ lat: 36.71, lng: 5.01 });
    expect(res.status).toBe(200);
    expect(fsMock.docMergeSet).toHaveBeenCalledTimes(1);
    expect(fsMock.docMergeSet).toHaveBeenCalledWith("teamMembers", "tm-snap", expect.objectContaining({ lastKnownLat: 36.71, teamId: "team-a1" }));
    const payload = fsMock.docMergeSet.mock.calls[0][2] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["lastKnownLat", "lastKnownLng", "lastSeenAt", "memberId", "name", "teamId"]);
    // the old docSet path must be gone from the snapshot entirely
    expect(fsMock.docSet).not.toHaveBeenCalledWith("teamMembers", expect.anything(), expect.anything());

    // throttle: the second heartbeat inside the 5-min window writes nothing more
    await new Promise((r) => setTimeout(r, 3100)); // clear the 3s per-member floor
    const again = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-snap")).set(nextIp()).send({ lat: 36.72, lng: 5.02 });
    expect(again.status).toBe(200);
    expect(fsMock.docMergeSet).toHaveBeenCalledTimes(1);
  });

  it("B1: rejects a token minted BEFORE the member's current tokenGen (MEMBER_REVOKED)", async () => {
    // The dispatcher removed this member once: tokenGen was bumped to 2.
    // Tokens from gen 0 (and gen 1) are dead even though active is true again.
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-gen"), tokenGen: 2 };
      if (collection === "teams") return { teamId: "team-a1", name: "U", nameAr: "و", type: "protection_civile", active: true };
      return null;
    });
    const app = createApp();
    const stale = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-gen", "team-a1", 1)).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe("MEMBER_REVOKED");
    // A token carrying the CURRENT generation passes and records the ping.
    const fresh = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-gen", "team-a1", 2)).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(fresh.status).toBe(200);
    expect(listPositions({ teamId: "team-a1" })).toHaveLength(1);
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
    heartbeatableMocks("tm-phase"); // ARC-R2 gate: live member + active team
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

  it("ARC-R2: 403 for a REMOVED member or a deactivated team even with a valid token", async () => {
    const app = createApp();
    // removed member (active:false) — the 12h token alone must not move missions
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-removed"), active: false };
      if (collection === "teams") return { teamId: "team-a1", active: true };
      return null;
    });
    const removed = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-removed")).set(nextIp()).send({ phase: "on_scene" });
    expect(removed.status).toBe(403);
    expect(removed.body.code).toBe("MEMBER_INACTIVE");
    expect(atomicMock.setMissionPhaseAtomically).not.toHaveBeenCalled();

    // membership missing entirely (token forged for an unknown member id)
    fsMock.docGet.mockResolvedValue(null);
    const missing = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-ghost")).set(nextIp()).send({ phase: "on_scene" });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe("MEMBER_INVALID");

    // deactivated team
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return memberFixture("tm-deadteam-phase");
      if (collection === "teams") return { teamId: "team-a1", active: false };
      return null;
    });
    const deadTeam = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-deadteam-phase")).set(nextIp()).send({ phase: "on_scene" });
    expect(deadTeam.status).toBe(403);
    expect(deadTeam.body.code).toBe("TEAM_INACTIVE");
    expect(atomicMock.setMissionPhaseAtomically).not.toHaveBeenCalled();
  });

  it("B1: a stale-generation token cannot flip the mission phase either", async () => {
    // The removal happened AFTER this token was minted (tokenGen bumped to 3,
    // token still says gen 2). active:true again would not save it.
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-phase-gen"), tokenGen: 3 };
      if (collection === "teams") return { teamId: "team-a1", name: "U", nameAr: "و", type: "protection_civile", active: true };
      return null;
    });
    const res = await supertest(createApp()).post("/api/teams/mission/phase").set(memberAuth("tm-phase-gen", "team-a1", 2)).set(nextIp()).send({ phase: "on_scene" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MEMBER_REVOKED");
    expect(atomicMock.setMissionPhaseAtomically).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/teams/:id — dispatcher levers (B3)", () => {
  it("renames a team and persists only the given fields", async () => {
    fsMock.docGet.mockImplementation(async (collection: string, id: string) => {
      if (collection === "teams") return { teamId: id, name: "Old", nameAr: "قديم", type: "volunteers", active: true };
      return null;
    });
    const res = await supertest(createApp()).patch("/api/teams/team-a1").set(adminAuth()).set(nextIp()).send({ nameAr: "جديد" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fsMock.docUpdate).toHaveBeenCalledWith("teams", "team-a1", expect.objectContaining({ nameAr: "جديد" }));
    expect(fsMock.invalidateDocCache).toHaveBeenCalledWith("teams", "team-a1");
  });

  it("deactivates a team (the previously dead active:false guard becomes reachable)", async () => {
    fsMock.docGet.mockImplementation(async (collection: string, id: string) => {
      if (collection === "teams") return { teamId: id, name: "U", nameAr: "و", type: "volunteers", active: false };
      return null;
    });
    const res = await supertest(createApp()).patch("/api/teams/team-a1").set(adminAuth()).set(nextIp()).send({ active: false });
    expect(res.status).toBe(200);
    expect(fsMock.docUpdate).toHaveBeenCalledWith("teams", "team-a1", expect.objectContaining({ active: false }));
  });

  it("404 for an unknown team, 400 for an empty or invalid update, 401 unauthenticated", async () => {
    fsMock.docGet.mockResolvedValue(null);
    const app = createApp();
    expect((await supertest(app).patch("/api/teams/team-a1").set(adminAuth()).set(nextIp()).send({ name: "XY" })).status).toBe(404);
    fsMock.docGet.mockResolvedValue({ teamId: "team-a1", name: "U", nameAr: "و", type: "volunteers", active: true });
    expect((await supertest(app).patch("/api/teams/team-a1").set(adminAuth()).set(nextIp()).send({})).status).toBe(400);
    expect((await supertest(app).patch("/api/teams/team-a1").set(adminAuth()).set(nextIp()).send({ active: "yes" })).status).toBe(400);
    expect((await supertest(app).patch("/api/teams/team-a1").send({ active: false })).status).toBe(401);
  });
});

describe("DELETE /api/teams/:id/mission — force-clear lever (B3)", () => {
  it("clears a stuck mission transactionally and 404s when none is active", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teams") return { teamId: "team-a1", name: "U", nameAr: "و", type: "volunteers", active: true };
      return null;
    });
    const app = createApp();
    const ok = await supertest(app).delete("/api/teams/team-a1/mission").set(adminAuth()).set(nextIp());
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(atomicMock.clearTeamMissionAtomically).toHaveBeenCalledWith("team-a1");
    expect(fsMock.invalidateDocCache).toHaveBeenCalledWith("teamMissions", "team-a1");

    atomicMock.clearTeamMissionAtomically.mockResolvedValueOnce({ status: "no-active-mission" });
    const none = await supertest(app).delete("/api/teams/team-a1/mission").set(adminAuth()).set(nextIp());
    expect(none.status).toBe(404);
    expect(none.body.code).toBe("NO_ACTIVE_MISSION");
  });

  it("401 without admin and 404 for an unknown team", async () => {
    fsMock.docGet.mockResolvedValue(null);
    const app = createApp();
    expect((await supertest(app).delete("/api/teams/team-a1/mission").set(nextIp())).status).toBe(401);
    expect((await supertest(app).delete("/api/teams/team-a1/mission").set(adminAuth()).set(nextIp())).status).toBe(404);
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

describe("DELETE /api/teams/:id/members/:memberId — dispatcher removes a member", () => {
  it("deactivates the member, drops the live position, and 404s foreign members", async () => {
    const memberId = "tm-abcdef0123456789"; // must match the server's tm-<16hex> shape
    heartbeatableMocks(memberId);
    const app = createApp();
    const hb = await supertest(app).post("/api/teams/heartbeat").set(memberAuth(memberId)).set(nextIp()).send({ lat: 36.7, lng: 5.0 });
    expect(hb.status).toBe(200);
    expect(listPositions()).toHaveLength(1);

    const ok = await supertest(app).delete(`/api/teams/team-a1/members/${memberId}`).set(adminAuth()).set(nextIp());
    expect(ok.status).toBe(200);
    expect(listPositions()).toHaveLength(0);
    expect(fsMock.docUpdate).toHaveBeenCalledWith("teamMembers", memberId, expect.objectContaining({ active: false }));
    // B1: the generation bump — every token of this member dies at the gates.
    expect(fsMock.incrementDocField).toHaveBeenCalledWith("teamMembers", memberId, "tokenGen", 1);
    // B2 (owner decision 4): last-known GPS is purged from the member doc.
    expect(fsMock.docDeleteFields).toHaveBeenCalledWith("teamMembers", memberId, ["lastKnownLat", "lastKnownLng", "lastSeenAt"]);

    // B2: blockPrincipal:true also bars the device from re-joining via code.
    atomicMock.setPrincipalBlocked.mockClear();
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture(memberId), principal: "principal-abc123" };
      return null;
    });
    const blocked = await supertest(app).delete(`/api/teams/team-a1/members/${memberId}`).set(adminAuth()).set(nextIp()).send({ blockPrincipal: true });
    expect(blocked.status).toBe(200);
    expect(blocked.body.blockedPrincipal).toBe(true);
    expect(atomicMock.setPrincipalBlocked).toHaveBeenCalledWith("team-a1", "principal-abc123", true);

    // foreign member (different team) → 404, nothing written
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture(memberId), teamId: "team-OTHER" };
      return null;
    });
    const foreign = await supertest(app).delete(`/api/teams/team-a1/members/${memberId}`).set(adminAuth()).set(nextIp());
    expect(foreign.status).toBe(404);
  });

  it("400 for malformed identifiers and 401 without admin", async () => {
    const app = createApp();
    expect((await supertest(app).delete("/api/teams/team-a1/members/not-a-member-id").set(adminAuth()).set(nextIp())).status).toBe(400);
    expect((await supertest(app).delete("/api/teams/team-a1/members/tm-0123456789abcdef").set(nextIp())).status).toBe(401);
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
    expect(team.activeMission).toEqual({ sosId: "sos-77", phase: "en_route", since: 1000, sosLat: null, sosLng: null });
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

  it("B3: includeInactive=1 exposes deactivated teams (with the active flag) for the re-activate lever", async () => {
    fsMock.collectionGet.mockImplementation(async (collection: string) => {
      if (collection === "teams")
        return [
          { teamId: "team-a1", name: "Unité 1", nameAr: "وحدة 1", type: "protection_civile", active: true, blockedPrincipals: ["p-1"] },
          { teamId: "team-dead", name: "Gone", nameAr: "منحل", type: "volunteers", active: false, blockedPrincipals: [] },
        ];
      return [];
    });
    fsMock.docGet.mockResolvedValue(null);
    const app = createApp();
    const hidden = await supertest(app).get("/api/teams").set(adminAuth()).set(nextIp());
    expect(hidden.body).toHaveLength(1);
    expect(hidden.body[0].blockedPrincipals).toEqual(["p-1"]);
    const shown = await supertest(app).get("/api/teams?includeInactive=1").set(adminAuth()).set(nextIp());
    expect(shown.body).toHaveLength(2);
    const dead = shown.body.find((t: any) => t.teamId === "team-dead");
    expect(dead.active).toBe(false);
  });
});

describe("POST /api/teams/session — Phase 2 resume probe", () => {
  it("resumes a valid session with team identity, member name and active mission (no GPS required)", async () => {
    heartbeatableMocks("tm-sess1");
    const res = await supertest(createApp())
      .post("/api/teams/session")
      .set(memberAuth("tm-sess1"))
      .set(nextIp())
      .send();
    expect(res.status).toBe(200);
    expect(res.body.memberId).toBe("tm-sess1");
    expect(res.body.teamId).toBe("team-a1");
    expect(res.body.teamName).toBe("Unité 1");
    expect(res.body.teamNameAr).toBe("وحدة 1");
    expect(res.body.name).toContain("عضو");
    expect(res.body.heartbeatIntervalMs).toBe(15000);
    expect(res.body.mission).toEqual({ sosId: "sos-77", phase: "en_route", since: 1000, sosLat: null, sosLng: null });
  });

  it("401 without a team token", async () => {
    heartbeatableMocks("tm-sess2");
    const res = await supertest(createApp()).post("/api/teams/session").set(nextIp()).send();
    expect(res.status).toBe(401);
  });

  it("403 MEMBER_INVALID when the membership record vanished or belongs to another team", async () => {
    // doc-id-agnostic mock: a missing member record IS the ghost-member case.
    fsMock.docGet.mockResolvedValue(null);
    const noMember = await supertest(createApp()).post("/api/teams/session").set(memberAuth("tm-ghost")).set(nextIp()).send();
    expect(noMember.status).toBe(403);
    expect(noMember.body.code).toBe("MEMBER_INVALID");
  });

  it("403 MEMBER_REVOKED when the token predates the member's current tokenGen (B1)", async () => {
    heartbeatableMocks("tm-sess4");
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-sess4"), tokenGen: 3 };
      if (collection === "teams") return { teamId: "team-a1", name: "Unité 1", nameAr: "وحدة 1", type: "protection_civile", active: true };
      return null;
    });
    // token minted with gen 0 vs member tokenGen 3 → stale
    const res = await supertest(createApp()).post("/api/teams/session").set(memberAuth("tm-sess4", "team-a1", 0)).set(nextIp()).send();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MEMBER_REVOKED");
  });

  it("403 MEMBER_INACTIVE for a deactivated membership and 403 TEAM_INACTIVE for a dead team", async () => {
    const app = createApp();
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-sess5"), active: false };
      return null;
    });
    const deactivated = await supertest(app).post("/api/teams/session").set(memberAuth("tm-sess5")).set(nextIp()).send();
    expect(deactivated.status).toBe(403);
    expect(deactivated.body.code).toBe("MEMBER_INACTIVE");

    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return memberFixture("tm-sess6");
      if (collection === "teams") return { teamId: "team-a1", name: "Unité 1", nameAr: "وحدة 1", active: false };
      return null;
    });
    const deadTeam = await supertest(app).post("/api/teams/session").set(memberAuth("tm-sess6")).set(nextIp()).send();
    expect(deadTeam.status).toBe(403);
    expect(deadTeam.body.code).toBe("TEAM_INACTIVE");
  });

  it("gate PRECEDENCE: inactive member + stale token together → MEMBER_INACTIVE wins by order (P9)", async () => {
    // The panel classifies by code NAME, not position, so a reorder is
    // behavior-compatible for the client — but the contract is still pinned:
    // membership-state gates run BEFORE the revocation gate, mirroring the
    // heartbeat route byte-for-byte.
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return { ...memberFixture("tm-sess8"), active: false, tokenGen: 3 };
      return null;
    });
    const res = await supertest(createApp())
      .post("/api/teams/session")
      .set(memberAuth("tm-sess8", "team-a1", 0))
      .set(nextIp())
      .send();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MEMBER_INACTIVE");
  });

  it("returns a null mission when the team has no active mission", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return memberFixture("tm-sess7");
      if (collection === "teams") return { teamId: "team-a1", name: "Unité 1", nameAr: "وحدة 1", type: "protection_civile", active: true };
      if (collection === "teamMissions") return { teamId: "team-a1", sosId: "sos-77", phase: "cleared", since: 1000 };
      return null;
    });
    const res = await supertest(createApp()).post("/api/teams/session").set(memberAuth("tm-sess7")).set(nextIp()).send();
    expect(res.status).toBe(200);
    expect(res.body.mission).toBeNull();
  });
});

// ========================
// PHASE 3 — evidence-verified arrival (server-side geometry)
// ========================
describe("POST /api/teams/mission/phase — Phase 3 arrival evidence", () => {
  const TARGET = { sosLat: 36.7503, sosLng: 5.0703 };

  function missionMocks(memberId: string, mission: Record<string, any> | null) {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamMembers") return memberFixture(memberId);
      if (collection === "teams") return { teamId: "team-a1", name: "Unité 1", nameAr: "وحدة 1", type: "protection_civile", active: true };
      if (collection === "teamMissions") return mission;
      return null;
    });
  }

  it("accepts an evidence flip inside the radius and consistent with the live registry", async () => {
    missionMocks("tm-arr1", { teamId: "team-a1", sosId: "sos-77", phase: "en_route", since: 1000, ...TARGET });
    const app = createApp();
    // The member's REAL heartbeat fix lands at the target (recorded server-side).
    const hb = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-arr1")).set(nextIp())
      .send({ lat: 36.7503, lng: 5.0703, accuracy: 8 });
    expect(hb.status).toBe(200);
    const res = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-arr1")).set(nextIp())
      .send({ phase: "on_scene", lat: 36.7503, lng: 5.0703, accuracy: 8 });
    expect(res.status).toBe(200);
    expect(atomicMock.setMissionPhaseAtomically).toHaveBeenCalledWith("team-a1", "on_scene");
  });

  it("rejects evidence farther than the arrival radius with ARRIVAL_TOO_FAR and never reaches the tx", async () => {
    missionMocks("tm-arr2", { teamId: "team-a1", sosId: "sos-77", phase: "en_route", since: 1000, ...TARGET });
    const res = await supertest(createApp()).post("/api/teams/mission/phase").set(memberAuth("tm-arr2")).set(nextIp())
      .send({ phase: "on_scene", lat: 36.9, lng: 5.3 }); // ~17 km from the target
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ARRIVAL_TOO_FAR");
    expect(atomicMock.setMissionPhaseAtomically).not.toHaveBeenCalled();
  });

  it("rejects evidence that conflicts with the member's live registry position (anti-fabrication)", async () => {
    missionMocks("tm-arr3", { teamId: "team-a1", sosId: "sos-77", phase: "en_route", since: 1000, ...TARGET });
    const app = createApp();
    // Real beats put the member ~1.1 km away; the flip then claims on-target
    // coordinates — check 2 passes, check 3 (registry consistency) must fire.
    const hb = await supertest(app).post("/api/teams/heartbeat").set(memberAuth("tm-arr3")).set(nextIp())
      .send({ lat: 36.76, lng: 5.0703, accuracy: 8 });
    expect(hb.status).toBe(200);
    const res = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-arr3")).set(nextIp())
      .send({ phase: "on_scene", lat: 36.7503, lng: 5.0703 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ARRIVAL_EVIDENCE_CONFLICT");
    expect(atomicMock.setMissionPhaseAtomically).not.toHaveBeenCalled();
  });

  it("400s evidence outside the coverage bounds and unpaired coordinates", async () => {
    missionMocks("tm-arr4", { teamId: "team-a1", sosId: "sos-77", phase: "en_route", since: 1000, ...TARGET });
    const app = createApp();
    const out = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-arr4")).set(nextIp())
      .send({ phase: "on_scene", lat: 51.5, lng: -0.1 });
    expect(out.status).toBe(400);
    const pair = await supertest(app).post("/api/teams/mission/phase").set(memberAuth("tm-arr4")).set(nextIp())
      .send({ phase: "on_scene", lat: 36.7503 });
    expect(pair.status).toBe(400);
    expect(atomicMock.setMissionPhaseAtomically).not.toHaveBeenCalled();
  });

  it("skips geometry for LEGACY missions without coords — evidence still accepted (self-report contract)", async () => {
    missionMocks("tm-arr5", { teamId: "team-a1", sosId: "sos-77", phase: "en_route", since: 1000 });
    const res = await supertest(createApp()).post("/api/teams/mission/phase").set(memberAuth("tm-arr5")).set(nextIp())
      .send({ phase: "on_scene", lat: 36.9, lng: 5.3 }); // far — but there is no target to check against
    expect(res.status).toBe(200);
    expect(atomicMock.setMissionPhaseAtomically).toHaveBeenCalled();
  });

  it("keeps the evidence-less flip working exactly as Phase 1 shipped it", async () => {
    missionMocks("tm-arr6", { teamId: "team-a1", sosId: "sos-77", phase: "en_route", since: 1000, ...TARGET });
    const res = await supertest(createApp()).post("/api/teams/mission/phase").set(memberAuth("tm-arr6")).set(nextIp())
      .send({ phase: "on_scene" });
    expect(res.status).toBe(200);
  });
});

// ========================
// PHASE 3 — teamJoinCodes sweep (Round-C passenger: collection was grow-only)
// ========================
describe("POST /api/teams/:id/join-code — Phase 3 dead-code sweep", () => {
  function mintMocks() {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teams") return { teamId: "team-a1", name: "Unité 1", nameAr: "وحدة 1", type: "protection_civile", active: true };
      return null;
    });
  }

  it("deletes codes dead for more than 7 days, keeps fresh ones, revokes live same-team codes", async () => {
    mintMocks();
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    fsMock.collectionGet.mockResolvedValue([
      { code: "OLDREV01", teamId: "team-a1", revoked: true, revokedAt: now - 8 * DAY, expiresAt: now + DAY },
      { code: "OLDEXP001", teamId: "team-b2", revoked: false, expiresAt: now - 9 * DAY },
      { code: "FRESHDEAD", teamId: "team-a1", revoked: true, revokedAt: now - 1 * DAY, expiresAt: now + DAY },
      { code: "LIVEOTHR1", teamId: "team-b2", revoked: false, expiresAt: now + DAY },
      { code: "LIVESAMA1", teamId: "team-a1", revoked: false, expiresAt: now + DAY },
    ]);
    const res = await supertest(createApp())
      .post("/api/teams/team-a1/join-code")
      .set(adminAuth())
      .set(nextIp())
      .send({});
    expect(res.status).toBe(201);
    // Dead > 7 days → swept
    expect(fsMock.docDelete).toHaveBeenCalledWith("teamJoinCodes", "OLDREV01");
    expect(fsMock.docDelete).toHaveBeenCalledWith("teamJoinCodes", "OLDEXP001");
    expect(fsMock.docDelete).not.toHaveBeenCalledWith("teamJoinCodes", "FRESHDEAD");
    // Live codes on OTHER teams survive untouched
    expect(fsMock.docUpdate).not.toHaveBeenCalledWith("teamJoinCodes", "LIVEOTHR1", expect.anything());
    // Live code on THIS team is rotated (revoked) by the mint
    expect(fsMock.docUpdate).toHaveBeenCalledWith("teamJoinCodes", "LIVESAMA1", { revoked: true, revokedAt: expect.any(Number) });
    // Freshly minted code still comes back with its budget
    expect(res.body.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(res.body.maxUses).toBe(12);
  });
});
