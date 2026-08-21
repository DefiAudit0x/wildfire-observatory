import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import express from "express";
import supertest from "supertest";

const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async () => []),
  docSet: vi.fn(async () => true),
  docGet: vi.fn(async () => null),
}));
vi.mock("../server/fs.js", () => fsMock);
import volunteersRouter from "../server/routes/volunteers.js";
import { generateAdminToken } from "../server/middleware.js";

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