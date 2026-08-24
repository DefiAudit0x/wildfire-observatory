import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import volunteersRouter from "../server/routes/volunteers.js";
import { generateAdminToken } from "../server/middleware.js";
import * as fs from "../server/fs.js";

const atomicReservations = vi.hoisted(() => new Map<string, string>());

vi.mock("../server/atomic.js", async () => {
  const actual = await vi.importActual<typeof import("../server/atomic.js")>("../server/atomic.js");
  const fsModule = await vi.importActual<typeof import("../server/fs.js")>("../server/fs.js");
  return {
    ...actual,
    createVolunteerRegistrationAtomically: vi.fn(async (
      registration: Record<string, any>,
      keys: { phoneHash: string; emailHash?: string; fullNameHash: string },
    ) => {
      const candidates = [
        { kind: "phone", key: keys.phoneHash },
        ...(keys.emailHash ? [{ kind: "email", key: keys.emailHash }] : []),
        { kind: "name", key: `${keys.fullNameHash}:${registration.wilaya}` },
      ];
      for (const candidate of candidates) {
        const existing = atomicReservations.get(`${candidate.kind}:${candidate.key}`);
        if (existing) {
          return candidate.kind === "phone" ? "duplicate-phone" : candidate.kind === "email" ? "duplicate-email" : "duplicate-name";
        }
      }
      if (!(await fsModule.docSet("volunteerRegistrations", registration.id, registration))) return "unavailable";
      for (const candidate of candidates) atomicReservations.set(`${candidate.kind}:${candidate.key}`, registration.id);
      return "created";
    }),
  };
});

function createVolunteersApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/volunteer", volunteersRouter);
  return app;
}

const VALID_PHONE = "0550123456";
let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter}`;

describe("POST /api/volunteer/register", () => {
  const app = createVolunteersApp();

  beforeEach(() => {
    vi.restoreAllMocks();
    atomicReservations.clear();
    vi.spyOn(fs, "docSet").mockResolvedValue(true);
  });

  it("rejects an invalid phone number format", async () => {
    const res = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "مختبر حماية",
      phone: "aaaaaa",
      wilaya: "الجزائر - تيبازة",
    });
    expect(res.status).toBe(400);
  });

  it("rejects foreign non-Maghreb numbers", async () => {
    const res = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "مختبر حماية",
      phone: "+33612345678",
      wilaya: "الجزائر - تيبازة",
    });
    expect(res.status).toBe(400);
  });

  it("registers with a valid Maghreb number, storing an unguessable id", async () => {
    const res = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "مختبر حماية",
      phone: VALID_PHONE,
      wilaya: "الجزائر - تيبازة",
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^reg-[0-9a-f]{12}$/);
  });

  it("rejects a duplicate phone number with 409", async () => {
    const res = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "مختبر حماية 2",
      phone: VALID_PHONE,
      wilaya: "الجزائر - عنابة",
    });
    expect(res.status).toBe(409);
  });

  it("answers honeypot submissions with a fake success, not a real registration", async () => {
    const res = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "بوت غبي",
      phone: "0555123456",
      wilaya: "الجزائر - باتنة",
      website: "spam.ru",
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^reg-fake-[0-9a-f]{8}$/);
  });

  it("rejects a duplicate email (hashed lookup, no PII decryption needed)", async () => {
    const first = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "مختبر بريد 1",
      phone: "0731311111",
      email: "dup-email@example.com",
      wilaya: "الجزائر - الجزائر",
    });
    expect(first.status).toBe(200);
    const res = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "مختبر بريد 2",
      phone: "0731312222",
      email: "DUP-EMAIL@example.com",
      wilaya: "الجزائر - تيبازة",
    });
    expect(res.status).toBe(409);
  });

  it("rejects the same name+wilaya within 30 days (normalized hash)", async () => {
    const first = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "أحمد بن عمر",
      phone: "0731313333",
      wilaya: "الجزائر - وهران",
    });
    expect(first.status).toBe(200);
    const res = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "   أحمد بن عمر ",
      phone: "0731314444",
      wilaya: "الجزائر - وهران",
    });
    expect(res.status).toBe(409);
  });

  it("fails closed when durable Firestore persistence fails", async () => {
    vi.mocked(fs.docSet).mockResolvedValue(false);
    const res = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "فشل حفظ",
      phone: "0731315555",
      wilaya: "الجزائر - الجلفة",
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Database not available" });
  });
});

describe("POST /api/volunteer/:id/approve", () => {
  const app = createVolunteersApp();
  const adminToken = generateAdminToken();

  it("rejects unauthenticated approval requests", async () => {
    const res = await supertest(app).post("/api/volunteer/reg-123456/approve").send({ status: "approved" });
    expect(res.status).toBe(401);
  });

  it("rejects invalid badge code formats", async () => {
    const res = await supertest(app)
      .post("/api/volunteer/reg-123456/approve")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "approved", assignedCode: "bad code!!" });
    expect(res.status).toBe(400);
  });

  it("rejects malformed registration ids (path traversal chars)", async () => {
    const res = await supertest(app)
      .post("/api/volunteer/abc.def%2F..%2Fetc/approve")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "approved" });
    expect([400, 404]).toContain(res.status);
  });
});
