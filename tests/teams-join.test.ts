import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
import { verifyTeamMemberToken } from "../server/teamAuth.js";
import { generateAdminToken } from "../server/middleware.js";

/**
 * Team Mode — join-code redemption (POST /api/teams/join).
 * The atomic redemption is mocked at the fs/atomic boundary exactly like the
 * rest of this repo's router tests; the route's normalization, principal
 * issuance, deterministic member id and response contract are what's under
 * test here.
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
  setMissionPhaseAtomically: vi.fn(async (..._a: any[]) => ({ status: "updated", mission: {} }) as any),
}));

vi.mock("../server/fs.js", () => fsMock);
vi.mock("../server/atomic.js", () => atomicMock);

import teamsRouter from "../server/routes/teams.js";

let ipCounter = 0;
function createApp() {
  ipCounter = 0;
  const app = express();
  app.set("trust proxy", 1); // house pattern: unique per-test XFF isolates limiters
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/teams", teamsRouter);
  return app;
}

function nextIp() {
  ipCounter += 1;
  return { "X-Forwarded-For": `10.78.${ipCounter}.9` };
}

const adminAuth = () => ({ authorization: `Bearer ${generateAdminToken()}` });

beforeEach(() => {
  fsMock.collectionGet.mockReset().mockResolvedValue([]);
  fsMock.docGet.mockReset().mockResolvedValue(null);
  fsMock.docSet.mockReset().mockResolvedValue(true);
  fsMock.docUpdate.mockReset().mockResolvedValue(true);
  atomicMock.joinTeamAtomically.mockReset().mockResolvedValue({ status: "joined", member: {} });
  atomicMock.setMissionPhaseAtomically.mockReset().mockResolvedValue({ status: "updated", mission: {} });
});

describe("POST /api/teams/join — happy path", () => {
  it("issues a principal cookie, mints a team token and returns the team card", async () => {
    fsMock.docGet.mockImplementation(async (collection: string, id: string) => {
      if (collection === "teamJoinCodes") return { code: id, teamId: "team-a1", revoked: false, expiresAt: Date.now() + 3_600_000, uses: 0, maxUses: 12 };
      if (collection === "teams") return { teamId: "team-a1", name: "Unité Béjaïa", nameAr: "وحدة بجاية", active: true };
      if (collection === "teamMissions") return { teamId: "team-a1", sosId: "sos-9", phase: "en_route", since: 123 };
      return null;
    });

    const res = await supertest(createApp())
      .post("/api/teams/join")
      .set(nextIp())
      .send({ code: "ABCD2345", name: "فريق الجبل" });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]?.[0]).toContain("public_principal=");
    expect(res.body.teamId).toBe("team-a1");
    expect(res.body.teamName).toBe("Unité Béjaïa");
    expect(res.body.teamNameAr).toBe("وحدة بجاية");
    expect(res.body.mission).toEqual({ sosId: "sos-9", phase: "en_route", since: 123 });

    const payload = verifyTeamMemberToken(res.body.token);
    expect(payload?.scope).toBe("team-member");
    expect(payload?.teamId).toBe("team-a1");
    expect(payload?.memberId).toBe(res.body.memberId);
    expect(res.body.memberId).toMatch(/^tm-[0-9a-f]{16}$/);

    const [code, memberId, memberData] = atomicMock.joinTeamAtomically.mock.calls[0];
    expect(code).toBe("ABCD2345");
    expect(memberId).toBe(res.body.memberId);
    expect(memberData).toMatchObject({ teamId: "team-a1", name: "فريق الجبل" });
    expect(memberData.principal).toMatch(/[0-9a-f-]{36}/);
  });

  it("produces the SAME memberId for the same principal+team and a different one per team", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamJoinCodes") return { teamId: "team-a1", revoked: false, expiresAt: Date.now() + 3_600_000, uses: 0, maxUses: 12 };
      if (collection === "teams") return { teamId: "team-a1", name: "T", nameAr: "ت", active: true };
      return null;
    });
    const app = createApp();
    const agent = supertest.agent(app);
    const first = await agent.post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" });
    const second = await agent.post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" });
    expect(second.body.memberId).toBe(first.body.memberId);

    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamJoinCodes") return { teamId: "team-b2", revoked: false, expiresAt: Date.now() + 3_600_000, uses: 0, maxUses: 12 };
      if (collection === "teams") return { teamId: "team-b2", name: "T2", nameAr: "ت2", active: true };
      return null;
    });
    const otherTeam = await agent.post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" });
    expect(otherTeam.body.memberId).not.toBe(first.body.memberId);
  });

  it("normalizes codes: lowercase, separators and mistyped glyphs", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamJoinCodes") return { teamId: "team-a1", revoked: false, expiresAt: Date.now() + 3_600_000 };
      if (collection === "teams") return { teamId: "team-a1", name: "T", nameAr: "ت", active: true };
      return null;
    });
    await supertest(createApp())
      .post("/api/teams/join")
      .set(nextIp())
      .send({ code: "abcd-2345", name: "فريق" }); // separators dropped → ABCD2345
    expect(atomicMock.joinTeamAtomically.mock.calls[0][0]).toBe("ABCD2345");
    await supertest(createApp())
      .post("/api/teams/join")
      .set(nextIp())
      .send({ code: "ab odil45", name: "فريق" }); // uppercase + separators stripped; lookalike glyphs pass through untouched (they can never match a generated code)
    expect(atomicMock.joinTeamAtomically.mock.calls[1][0]).toBe("ABODIL45");
  });

  it("strips control characters from the display name", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamJoinCodes") return { teamId: "team-a1", revoked: false, expiresAt: Date.now() + 3_600_000 };
      if (collection === "teams") return { teamId: "team-a1", name: "T", nameAr: "ت", active: true };
      return null;
    });
    await supertest(createApp()).post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق\n\t\u0000" });
    const data = atomicMock.joinTeamAtomically.mock.calls[0][2] as Record<string, any>;
    expect(data.name).toBe("فريق");
  });
});

describe("POST /api/teams/join — failure paths", () => {
  it("404 with generic message for an unknown code (never leaks why)", async () => {
    fsMock.docGet.mockResolvedValue(null);
    const res = await supertest(createApp()).post("/api/teams/join").set(nextIp()).send({ code: "ZZZZ9999", name: "فريق" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/غير صالح/i);
    expect(atomicMock.joinTeamAtomically).not.toHaveBeenCalled();
  });

  it("404 for a code pointing at a missing/inactive team", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamJoinCodes") return { teamId: "team-gone", revoked: false, expiresAt: Date.now() + 3_600_000 };
      return null; // team doc missing
    });
    const res = await supertest(createApp()).post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" });
    expect(res.status).toBe(404);
  });

  it("maps atomic results: expired/exhausted → 404, team-inactive → 409, unavailable → 503", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamJoinCodes") return { teamId: "team-a1", revoked: false, expiresAt: Date.now() + 3_600_000 };
      if (collection === "teams") return { teamId: "team-a1", name: "T", nameAr: "ت", active: true };
      return null;
    });
    const app = createApp();

    atomicMock.joinTeamAtomically.mockResolvedValueOnce({ status: "code-expired" });
    expect((await supertest(app).post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" })).status).toBe(404);

    atomicMock.joinTeamAtomically.mockResolvedValueOnce({ status: "code-exhausted" });
    expect((await supertest(app).post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" })).status).toBe(404);

    atomicMock.joinTeamAtomically.mockResolvedValueOnce({ status: "team-inactive" });
    const inactive = await supertest(app).post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" });
    expect(inactive.status).toBe(409);

    atomicMock.joinTeamAtomically.mockResolvedValueOnce({ status: "unavailable" });
    expect((await supertest(app).post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" })).status).toBe(503);
  });

  it("400 for malformed body: wrong code length or empty name", async () => {
    const app = createApp();
    expect((await supertest(app).post("/api/teams/join").send({ code: "AB2", name: "فريق" })).status).toBe(400);
    expect((await supertest(app).post("/api/teams/join").send({ code: "ABCD2345", name: "" })).status).toBe(400);
    expect((await supertest(app).post("/api/teams/join").send({ code: "ABCD2345O", name: "فريق" })).status).toBe(400); // O→0 → 8? ABCD02345 = 9 chars → 400
  });

  it("invalidates the join-code and member caches after a successful redemption", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teamJoinCodes") return { teamId: "team-a1", revoked: false, expiresAt: Date.now() + 3_600_000 };
      if (collection === "teams") return { teamId: "team-a1", name: "T", nameAr: "ت", active: true };
      return null;
    });
    await supertest(createApp()).post("/api/teams/join").set(nextIp()).send({ code: "ABCD2345", name: "فريق" });
    expect(fsMock.invalidateCollectionCache).toHaveBeenCalledWith("teamJoinCodes");
    expect(fsMock.invalidateCollectionCache).toHaveBeenCalledWith("teamMembers");
    expect(fsMock.invalidateDocCache).toHaveBeenCalledWith("teamMembers", expect.stringMatching(/^tm-/));
  });
});

describe("POST /api/teams/:id/join-code — admin minting and rotation", () => {
  it("mints an 8-char unambiguous code with default TTL/uses", async () => {
    fsMock.docGet.mockResolvedValue({ teamId: "team-a1", name: "T", nameAr: "ت", active: true });
    const res = await supertest(createApp())
      .post("/api/teams/team-a1/join-code")
      .set(adminAuth())
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(res.body.maxUses).toBe(12);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("revokes the team's previous active codes (rotation = one live capability)", async () => {
    fsMock.docGet.mockResolvedValue({ teamId: "team-a1", active: true });
    fsMock.collectionGet.mockResolvedValue([
      { code: "OLDCODE1", teamId: "team-a1", revoked: false },
      { code: "OTHERTEAM", teamId: "team-x9", revoked: false },
      { code: "DEADC0DE", teamId: "team-a1", revoked: true },
    ]);
    const res = await supertest(createApp())
      .post("/api/teams/team-a1/join-code")
      .set(adminAuth())
      .send({});
    expect(res.status).toBe(201);
    const revoked = fsMock.docUpdate.mock.calls.filter(([c]: any[]) => c === "teamJoinCodes");
    expect(revoked).toHaveLength(1);
    expect(revoked[0][1]).toBe("OLDCODE1");
    expect(revoked[0][2]).toMatchObject({ revoked: true });
  });

  it("404 for unknown or deactivated team", async () => {
    fsMock.docGet.mockResolvedValue(null);
    expect((await supertest(createApp()).post("/api/teams/team-no/join-code").set(adminAuth()).send({})).status).toBe(404);
    fsMock.docGet.mockResolvedValue({ teamId: "team-a1", active: false });
    expect((await supertest(createApp()).post("/api/teams/team-a1/join-code").set(adminAuth()).send({})).status).toBe(404);
  });

  it("rejects unauthenticated callers", async () => {
    const res = await supertest(createApp()).post("/api/teams/team-a1/join-code").send({});
    expect(res.status).toBe(401);
  });
});
