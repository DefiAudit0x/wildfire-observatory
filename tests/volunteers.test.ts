import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import volunteersRouter from "../server/routes/volunteers.js";

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
});