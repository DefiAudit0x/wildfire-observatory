import { describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { generateStaffToken } from "../server/middleware.js";

vi.mock("../server/atomic.js", () => ({
  getFreshDoc: async (collection: string, id: string) => {
    if (collection !== "users") return null;
    if (id === "unknown-agent") return null;
    return { id, role: "agent", isActive: true, unitId: "unit-dz16", name: id === "a1" ? "علي" : id };
  },
  appendRosterPostAtomic: async () => "created",
}));

const { default: rosterRouter, MAX_PERSONNEL_PER_POST, MAX_POSTS_PER_DAY } = await import("../server/routes/roster.js");

function createApp() { const app = express(); app.use(express.json()); app.use("/api/roster", rosterRouter); return app; }
function token(role: "agent" | "commander" | "superadmin", unitId?: string) { return generateStaffToken({ role, unitId, agentId: `t-${role}` }); }
function pastDateISO(daysAgo: number): string { const d = new Date(); d.setDate(d.getDate() - daysAgo); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayISO(): string { const d = new Date(); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function futureDateISO(daysAhead: number): string { const d = new Date(); d.setDate(d.getDate() + daysAhead); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

describe("GET /api/roster/:date", () => {
  it("returns 401 without a token", async () => { const res = await supertest(createApp()).get("/api/roster/2026-08-07"); expect(res.status).toBe(401); });
  it("returns 400 for a malformed date", async () => { const res = await supertest(createApp()).get("/api/roster/07-08-2026").set("Authorization", `Bearer ${token("agent", "DZ16")}`); expect(res.status).toBe(400); });
  it("lets an agent read their unit's roster (empty when never saved)", async () => { const res = await supertest(createApp()).get("/api/roster/2026-08-07").set("Authorization", `Bearer ${token("agent", "DZ16")}`); expect(res.status).toBe(200); expect(res.body.unitId).toBe("unit-dz16"); expect(res.body.posts).toEqual([]); expect(res.body.saved).toBe(false); });
  it("lets a superadmin read a specific unit via ?unit=", async () => { const res = await supertest(createApp()).get("/api/roster/2026-08-07?unit=ALG").set("Authorization", `Bearer ${token("superadmin")}`); expect(res.status).toBe(200); expect(res.body.unitId).toBe("unit-alg"); });
});

describe("PUT /api/roster/:date (write permissions)", () => {
  it("forbids an agent from writing", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("agent", "DZ16")}`).send({ posts: [] }); expect(res.status).toBe(403); });
  it("allows a commander to write to their own unit", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [] }); expect([503, 500]).toContain(res.status); });
  it("allows a superadmin to write to a unit via ?unit=", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}?unit=ALG`).set("Authorization", `Bearer ${token("superadmin")}`).send({ posts: [] }); expect([503, 500]).toContain(res.status); });
  it("rejects a superadmin without a unit", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("superadmin")}`).send({ posts: [] }); expect(res.status).toBe(403); });
  it("rejects assigning the same agent twice on one day", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [{ labelAr: "منصب 1", personnel: [{ agentId: "a1", name: "علي" }] }, { labelAr: "منصب 2", personnel: [{ agentId: "a1", name: "علي" }] }] }); expect(res.status).toBe(403); });
  it("rejects a post exceeding MAX_PERSONNEL_PER_POST", async () => { const personnel = Array.from({ length: MAX_PERSONNEL_PER_POST + 1 }, (_, i) => ({ agentId: `a${i}`, name: `Agent ${i}` })); const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [{ labelAr: "منصب", personnel }] }); expect(res.status).toBe(400); });
  it("rejects more than MAX_POSTS_PER_DAY", async () => { const posts = Array.from({ length: MAX_POSTS_PER_DAY + 1 }, (_, i) => ({ labelAr: `منصب ${i}`, personnel: [] })); const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts }); expect(res.status).toBe(400); });
  it("rejects personnel whose authoritative staff record is unavailable", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [{ labelAr: "منصب", personnel: [{ agentId: "unknown-agent", name: "Forged Name" }] }] }); expect(res.status).toBe(403); });
});

describe("POST /api/roster/:date (single post)", () => {
  it("forbids agents", async () => { const res = await supertest(createApp()).post(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("agent", "DZ16")}`).send({ labelAr: "منصب", personnel: [] }); expect(res.status).toBe(403); });
  it("rejects unknown personnel instead of trusting caller-supplied identity", async () => { const res = await supertest(createApp()).post(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ labelAr: "سيارة إسعاف", personnel: [{ agentId: "unknown-agent", name: "Forged Name" }] }); expect(res.status).toBe(403); });
});

describe("Archived dates (read-only)", () => {
  it("rejects PUT on a past date with 409", async () => { const res = await supertest(createApp()).put(`/api/roster/${pastDateISO(3)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [] }); expect(res.status).toBe(409); });
  it("rejects POST on a past date with 409", async () => { const res = await supertest(createApp()).post(`/api/roster/${pastDateISO(3)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ labelAr: "منصب", personnel: [] }); expect(res.status).toBe(409); });
  it("rejects DELETE on a past date with 409", async () => { const res = await supertest(createApp()).delete(`/api/roster/${pastDateISO(3)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`); expect(res.status).toBe(409); });
  it("allows writing to a future date", async () => { const res = await supertest(createApp()).put(`/api/roster/${futureDateISO(2)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [] }); expect([503, 500]).toContain(res.status); });
});

describe("POST /api/roster/:date/copy-to/:target", () => {
  it("forbids agents", async () => { const res = await supertest(createApp()).post(`/api/roster/${pastDateISO(1)}/copy-to/${futureDateISO(1)}`).set("Authorization", `Bearer ${token("agent", "DZ16")}`); expect(res.status).toBe(403); });
  it("rejects copying into a past (archived) date", async () => { const res = await supertest(createApp()).post(`/api/roster/${futureDateISO(1)}/copy-to/${pastDateISO(1)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`); expect(res.status).toBe(409); });
  it("returns 404 when source has no saved roster", async () => { const res = await supertest(createApp()).post(`/api/roster/${futureDateISO(1)}/copy-to/${futureDateISO(2)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`); expect(res.status).toBe(404); });
});