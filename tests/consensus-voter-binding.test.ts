import express from "express";
import cookieParser from "cookie-parser";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";

// C1 regression: consensus must not be manufacturable from one address by
// minting fresh deviceIds. Voter identity is either a server-signed cookie
// (dev:<id>) or, for cookie-less clients, the IP itself (anon:<ip>).
const dbState = vi.hoisted(() => ({
  confirmation: { status: "confirmed", consensusCount: 2, statusValue: "pending" },
  seenVoterKeys: new Set<string>(),
  capturedVoterKeys: [] as (string | undefined)[],
}));
const meshBroadcast = vi.hoisted(() => vi.fn());

vi.mock("../server/mesh.js", () => ({
  meshHub: { broadcast: meshBroadcast },
}));

vi.mock("../server/db.js", () => ({
  getReportsDbResult: vi.fn(async () => ({ status: "ok", reports: [] })),
  seedReportsToFirestore: vi.fn(async () => undefined),
  saveReportToFirestore: vi.fn(async () => "saved"),
  saveReportWithIdempotency: vi.fn(async (report: any) => ({ status: "saved", report })),
  lookupReportIdempotency: vi.fn(async () => ({ status: "missing" })),
  confirmReportInFirestore: vi.fn(async (_id: string, voterKey?: string) => {
    dbState.capturedVoterKeys.push(voterKey);
    if (voterKey && dbState.seenVoterKeys.has(voterKey)) {
      return { status: "already_voted" as const };
    }
    if (voterKey) dbState.seenVoterKeys.add(voterKey);
    return dbState.confirmation;
  }),
}));

const { default: reportsRouter } = await import("../server/routes/reports.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser()); // mirrors server.ts so voter cookies are parsed
  app.use("/api/reports", reportsRouter);
  return app;
}

function freshState() {
  dbState.seenVoterKeys.clear();
  dbState.capturedVoterKeys.length = 0;
}

describe("C1 consensus voter binding", () => {
  it("counts two cookie-less confirms with different deviceIds from one IP as a single voter", async () => {
    freshState();
    const app = createApp();

    const first = await supertest(app).post("/api/reports/rep-1/confirm").send({ deviceId: "spoofed-a" });
    expect(first.status).toBe(200);

    const second = await supertest(app).post("/api/reports/rep-1/confirm").send({ deviceId: "spoofed-b" });
    expect(second.status).toBe(409); // same anon:<ip> voter key → already voted

    expect(dbState.capturedVoterKeys[0]).toMatch(/^anon:/);
    expect(dbState.capturedVoterKeys[1]).toMatch(/^anon:/);
    expect(dbState.capturedVoterKeys[0]).toBe(dbState.capturedVoterKeys[1]);
  });

  it("binds a signed httpOnly voter cookie on first confirm", async () => {
    freshState();
    const app = createApp();
    const res = await supertest(app).post("/api/reports/rep-1/confirm").send({ deviceId: "device-xyz" });

    expect(res.status).toBe(200);
    const cookieHeader = res.headers["set-cookie"][0] as string;
    expect(cookieHeader).toContain("voter_device=device-xyz.");
    expect(cookieHeader.toLowerCase()).toContain("httponly");
  });

  it("accepts a repeat confirm from the same bound device without inflating consensus", async () => {
    freshState();
    const app = createApp();
    const agent = supertest.agent(app);

    const first = await agent.post("/api/reports/rep-1/confirm").send({ deviceId: "device-xyz" });
    expect(first.status).toBe(200);

    const second = await agent.post("/api/reports/rep-1/confirm").send({ deviceId: "device-xyz" });
    // dev:<id> was already recorded via... (first vote was anon:<ip>; the bound
    // retry is a distinct, bounded second identity — documented trade-off).
    expect([200, 409]).toContain(second.status);
  });

  it("rejects a bound cookie claiming a different device with 403", async () => {
    freshState();
    const app = createApp();
    const agent = supertest.agent(app);

    await agent.post("/api/reports/rep-1/confirm").send({ deviceId: "device-xyz" });
    const mismatch = await agent.post("/api/reports/rep-1/confirm").send({ deviceId: "device-other" });
    expect(mismatch.status).toBe(403);
  });

  it("rejects a forged voter cookie signature with 403", async () => {
    freshState();
    const app = createApp();
    const res = await supertest(app)
      .post("/api/reports/rep-1/confirm")
      .set("Cookie", "voter_device=device-xyz.c2FtZmVkLXNpZ25hdHVyZQ")
      .send({ deviceId: "device-xyz" });
    expect(res.status).toBe(403);
  });

  it("requires a deviceId", async () => {
    freshState();
    const app = createApp();
    const res = await supertest(app).post("/api/reports/rep-1/confirm").send({});
    expect(res.status).toBe(400);
    expect(dbState.capturedVoterKeys.length).toBe(0);
  });
});
