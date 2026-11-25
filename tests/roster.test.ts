import { describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { generateStaffToken } from "../server/middleware.js";

vi.mock("../server/firebase.js", () => ({ getDb: () => ({}) }));
vi.mock("../server/fs.js", () => ({
  docGet: async (collection: string, id: string) => collection === "users" && id.startsWith("t-")
    ? { agentId: id, role: id.slice(2), unitId: id === "t-superadmin" ? undefined : "DZ16", isActive: true } : null,
  docSet: async () => false,
  collectionGet: async () => null,
  docDelete: async () => false,
}));

const rosterReadState = vi.hoisted(() => ({ mode: "missing" as "missing" | "error" | "found" }));

vi.mock("../server/atomic.js", () => ({
  getFreshDoc: async (collection: string, id: string) => {
    if (collection !== "users") return null;
    if (id === "unknown-agent") return null;
    return { id, role: "agent", isActive: true, unitId: "unit-dz16", name: id === "a1" ? "علي" : id };
  },
  // ARC-M08: canonicalizePersonnel now prefers getFreshDocResult — mirror the
  // same fixtures so both entry points stay covered.
  getFreshDocResult: async (collection: string, id: string) => {
    if (collection !== "users") {
      // Fix 15: the roster GET now reads through getFreshDocResult, so the
      // mock must be able to simulate a failed read and a found day too.
      if (rosterReadState.mode === "error") return { status: "error" };
      if (rosterReadState.mode === "found") return { status: "found", doc: { id, unitId: "unit-dz16", date: id, posts: [{ id: "p1", labelAr: "منصب", personnel: [] }] } };
      return { status: "missing" };
    }
    if (id === "unknown-agent") return { status: "missing" };
    // Fix 42 (RSTR-7): simulate a failed fresh read — the route must answer
    // 503 "Database not available", not 403 "not an active staff account".
    if (id === "error-agent") return { status: "error" };
    return {
      status: "found",
      doc: { id, role: "agent", isActive: true, unitId: "unit-dz16", name: id === "a1" ? "علي" : id },
    };
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
  it("returns the saved roster when the day exists", async () => {
    rosterReadState.mode = "found";
    try {
      const res = await supertest(createApp()).get("/api/roster/2026-08-07").set("Authorization", `Bearer ${token("agent", "DZ16")}`);
      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(true);
      expect(res.body.posts).toEqual([{ id: "p1", labelAr: "منصب", personnel: [] }]);
    } finally {
      rosterReadState.mode = "missing";
    }
  });
  it("returns 503 when the roster read fails instead of an empty unsaved roster", async () => {
    rosterReadState.mode = "error";
    try {
      const res = await supertest(createApp()).get("/api/roster/2026-08-07").set("Authorization", `Bearer ${token("agent", "DZ16")}`);
      expect(res.status).toBe(503);
      expect(res.body.saved).toBeUndefined();
      expect(res.body.posts).toBeUndefined();
    } finally {
      rosterReadState.mode = "missing";
    }
  });
  it("lets a superadmin read a specific unit via ?unit=", async () => { const res = await supertest(createApp()).get("/api/roster/2026-08-07?unit=ALG").set("Authorization", `Bearer ${token("superadmin")}`); expect(res.status).toBe(200); expect(res.body.unitId).toBe("unit-alg"); });
});

describe("PUT /api/roster/:date (write permissions)", () => {
  it("forbids an agent from writing", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("agent", "DZ16")}`).send({ posts: [] }); expect(res.status).toBe(403); });
  it("allows a commander to write to their own unit", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [] }); expect(res.status).toBe(503); expect(res.body.error).toBe("Database not available"); });
  it("allows a superadmin to write to a unit via ?unit=", async () => { const res = await supertest(createApp()).put(`/api/roster/${todayISO()}?unit=ALG`).set("Authorization", `Bearer ${token("superadmin")}`).send({ posts: [] }); expect(res.status).toBe(503); expect(res.body.error).toBe("Database not available"); });
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
  it("allows writing to a future date", async () => { const res = await supertest(createApp()).put(`/api/roster/${futureDateISO(2)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [] }); expect(res.status).toBe(503); expect(res.body.error).toBe("Database not available"); });
});

describe("POST /api/roster/:date/copy-to/:target", () => {
  it("forbids agents", async () => { const res = await supertest(createApp()).post(`/api/roster/${pastDateISO(1)}/copy-to/${futureDateISO(1)}`).set("Authorization", `Bearer ${token("agent", "DZ16")}`); expect(res.status).toBe(403); });
  it("rejects copying into a past (archived) date", async () => { const res = await supertest(createApp()).post(`/api/roster/${futureDateISO(1)}/copy-to/${pastDateISO(1)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`); expect(res.status).toBe(409); });
  it("returns 404 when source has no saved roster", async () => { const res = await supertest(createApp()).post(`/api/roster/${futureDateISO(1)}/copy-to/${futureDateISO(2)}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`); expect(res.status).toBe(404); });
});
describe("Fix 42 (RSTR-6): impossible calendar dates", () => {
  // A shape regex admits "2026-11-31" and "2026-99-99": isArchivedDate is
  // lexical and isTooFarFuture sees NaN as "not too far", so the old code
  // persisted rosters under nonexistent days. Each finding test expects 400
  // with the distinct calendar-date message; the old code answers something
  // else (noted per test).
  it("GET rejects 2026-02-30 (old: 200 with an empty roster)", async () => {
    const res = await supertest(createApp()).get("/api/roster/2026-02-30").set("Authorization", `Bearer ${token("agent", "DZ16")}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid date (not a real calendar date)");
  });
  it("PUT rejects 2026-11-31 (old: 503 via the docSet mock)", async () => {
    const res = await supertest(createApp()).put("/api/roster/2026-11-31").set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid date (not a real calendar date)");
  });
  it("POST rejects 2026-11-31 (old: 201)", async () => {
    const res = await supertest(createApp()).post("/api/roster/2026-11-31").set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ labelAr: "منصب", personnel: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid date (not a real calendar date)");
  });
  it("DELETE rejects 2026-13-01 (old: 404)", async () => {
    const res = await supertest(createApp()).delete("/api/roster/2026-13-01").set("Authorization", `Bearer ${token("commander", "DZ16")}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid date (not a real calendar date)");
  });
  it("copy-to rejects a nonexistent target (old: 404 for a missing source)", async () => {
    // Fix 42 correction to the prep: the prep's target 2026-02-30 is PAST,
    // so the old code answered 409 (archived target), not 404. 2027-02-30
    // is future and nonexistent: the old code passes the date guards and
    // 404s on the missing source; the new code 400s on the calendar check.
    const res = await supertest(createApp()).post(`/api/roster/${todayISO()}/copy-to/2027-02-30`).set("Authorization", `Bearer ${token("commander", "DZ16")}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid date (not a real calendar date)");
  });
  it("control: GET accepts 2028-02-29 (a real leap day)", async () => {
    const res = await supertest(createApp()).get("/api/roster/2028-02-29").set("Authorization", `Bearer ${token("agent", "DZ16")}`);
    expect(res.status).toBe(200);
  });
  it("control: GET rejects 2026-02-29 (2026 is not a leap year)", async () => {
    const res = await supertest(createApp()).get("/api/roster/2026-02-29").set("Authorization", `Bearer ${token("agent", "DZ16")}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid date (not a real calendar date)");
  });
});

describe("Fix 42 (RSTR-7): a failed fresh read is a 503, not a 403", () => {
  // canonicalizePersonnel used to drop getFreshDocResult's "error" outcome,
  // so a DB outage during a roster write reported 403 "not an active staff
  // account". The "error-agent" fixture makes the fresh read fail; the
  // route must answer 503 with the file's existing "Database not available"
  // body. The third call site (copy-to) shares the identical shape and is
  // verified by code reading — proving it would need a fixture change.
  it("PUT returns 503 when the personnel fresh read fails", async () => {
    const res = await supertest(createApp()).put(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ posts: [{ labelAr: "منصب", personnel: [{ agentId: "error-agent", name: "Outage Agent" }] }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Database not available");
  });
  it("POST returns 503 when the personnel fresh read fails", async () => {
    const res = await supertest(createApp()).post(`/api/roster/${todayISO()}`).set("Authorization", `Bearer ${token("commander", "DZ16")}`).send({ labelAr: "منصب", personnel: [{ agentId: "error-agent", name: "Outage Agent" }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Database not available");
  });
});
