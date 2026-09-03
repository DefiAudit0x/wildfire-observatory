import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";
import { generateAdminToken } from "../server/middleware.js";

/**
 * Team Mode — dispatching REGISTERED teams by teamId through the SOS dispatch
 * transaction. The 409 team_busy contract (ARC-H2/H8) must hold for BOTH the
 * new teamId path and the legacy display-name path.
 */

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async (..._a: any[]) => [] as any),
  docGet: vi.fn(async (..._a: any[]) => null as any),
  docSet: vi.fn(async (..._a: any[]) => true as any),
  docUpdate: vi.fn(async (..._a: any[]) => true as any),
  appendSosDispatch: vi.fn(async (..._a: any[]) => "ok" as any),
  clearTeamMissionsForSos: vi.fn(async (..._a: any[]) => true as any),
}));

vi.mock("../server/fs.js", () => fsMock);

import sosRouter from "../server/routes/sos.js";

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/sos", sosRouter);
  return app;
}

const adminAuth = () => ({ authorization: `Bearer ${generateAdminToken()}` });

beforeEach(() => {
  fsMock.collectionGet.mockReset().mockResolvedValue([]);
  fsMock.docGet.mockReset().mockResolvedValue(null);
  fsMock.docSet.mockReset().mockResolvedValue(true);
  fsMock.docUpdate.mockReset().mockResolvedValue(true);
  fsMock.appendSosDispatch.mockReset().mockResolvedValue("ok");
  fsMock.clearTeamMissionsForSos.mockReset().mockResolvedValue(true);
});

describe("POST /api/sos/:id/dispatch — registered team (teamId)", () => {
  it("resolves names/type from the team entity and locks the mission on the teamId", async () => {
    fsMock.docGet.mockImplementation(async (collection: string) => {
      if (collection === "teams")
        return { teamId: "team-a1", name: "Unité Béjaïa", nameAr: "وحدة بجاية", type: "protection_civile", active: true };
      return null;
    });
    const res = await supertest(createApp())
      .post("/api/sos/sos-1/dispatch")
      .set(adminAuth())
      .send({ teamId: "team-a1", notes: "انطلقوا فورًا" });

    expect(res.status).toBe(200);
    expect(fsMock.appendSosDispatch).toHaveBeenCalledTimes(1);
    const [sosId, dispatchItem, missionTeamId] = fsMock.appendSosDispatch.mock.calls[0];
    expect(sosId).toBe("sos-1");
    expect(missionTeamId).toBe("team-a1");
    expect(dispatchItem).toMatchObject({
      teamId: "team-a1",
      type: "protection_civile",
      teamNameAr: "وحدة بجاية",
      teamNameFr: "Unité Béjaïa",
      status: "en_route",
      notes: "انطلقوا فورًا",
    });
  });

  it("404 when the team is unknown or deactivated (no mission consumed)", async () => {
    fsMock.docGet.mockResolvedValue({ teamId: "team-a1", active: false });
    expect(
      (await supertest(createApp()).post("/api/sos/sos-1/dispatch").set(adminAuth()).send({ teamId: "team-a1" })).status
    ).toBe(404);
    expect(fsMock.appendSosDispatch).not.toHaveBeenCalled();
  });

  it("propagates team_busy as 409 TEAM_ALREADY_DISPATCHED (registered path)", async () => {
    fsMock.docGet.mockResolvedValue({ teamId: "team-a1", name: "T", nameAr: "ت", type: "volunteers", active: true });
    fsMock.appendSosDispatch.mockResolvedValueOnce("team_busy");
    const res = await supertest(createApp()).post("/api/sos/sos-1/dispatch").set(adminAuth()).send({ teamId: "team-a1" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TEAM_ALREADY_DISPATCHED");
  });

  it("propagates resolved/missing/unavailable outcomes unchanged", async () => {
    fsMock.docGet.mockResolvedValue({ teamId: "team-a1", name: "T", nameAr: "ت", type: "volunteers", active: true });
    const app = createApp();
    fsMock.appendSosDispatch.mockResolvedValueOnce("resolved");
    expect((await supertest(app).post("/api/sos/sos-1/dispatch").set(adminAuth()).send({ teamId: "team-a1" })).status).toBe(409);
    fsMock.appendSosDispatch.mockResolvedValueOnce("missing");
    expect((await supertest(app).post("/api/sos/sos-1/dispatch").set(adminAuth()).send({ teamId: "team-a1" })).status).toBe(404);
    fsMock.appendSosDispatch.mockResolvedValueOnce("unavailable");
    expect((await supertest(app).post("/api/sos/sos-1/dispatch").set(adminAuth()).send({ teamId: "team-a1" })).status).toBe(503);
  });
});

describe("POST /api/sos/:id/dispatch — legacy free-text path removed (v2.3.0)", () => {
  it("rejects dispatch by display names — only a registered teamId dispatches", async () => {
    // The legacy path let an operator dispatch phantom teams that never
    // existed ("متطوعو بجاية" with no entity behind it). v2.3.0 removed it
    // with the simulated dispatch table: the schema now REQUIRES teamId.
    const res = await supertest(createApp())
      .post("/api/sos/sos-1/dispatch")
      .set(adminAuth())
      .send({ type: "volunteers", teamNameAr: "متطوعو بجاية", teamNameFr: "Volontaires Béjaïa" });
    expect(res.status).toBe(400);
    expect(fsMock.appendSosDispatch).not.toHaveBeenCalled();
  });

  it("400 when teamId is missing or malformed", async () => {
    const app = createApp();
    expect((await supertest(app).post("/api/sos/sos-1/dispatch").set(adminAuth()).send({})).status).toBe(400);
    expect((await supertest(app).post("/api/sos/sos-1/dispatch").set(adminAuth()).send({ type: "volunteers" })).status).toBe(400);
    expect((await supertest(app).post("/api/sos/sos-1/dispatch").set(adminAuth()).send({ teamId: "bad id!" })).status).toBe(400);
  });
});
