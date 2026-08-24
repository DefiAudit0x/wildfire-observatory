import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import volunteersRouter from "../server/routes/volunteers.js";
import { generateAdminToken } from "../server/middleware.js";
import * as fs from "../server/fs.js";

type Doc = Record<string, any>;
type State = { docs: Map<string, Doc>; queue: Promise<void>; available: boolean };
const state = vi.hoisted<State>(() => ({ docs: new Map(), queue: Promise.resolve(), available: true }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => state.available ? createDb() : null,
  isAdminDb: () => true,
}));

function snapshot(path: string) {
  const data = state.docs.get(path);
  return { exists: Boolean(data), id: path.split("/").at(-1), data: () => data };
}

function createDb() {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          const path = `${name}/${id}`;
          return { id, path };
        },
      };
    },
    async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const previous = state.queue;
      let release!: () => void;
      state.queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const writes: Array<{ kind: "create" | "set" | "update"; path: string; data: Doc }> = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        create: (ref: { path: string }, data: Doc) => {
          if (state.docs.has(ref.path)) throw new Error(`Document already exists: ${ref.path}`);
          writes.push({ kind: "create", path: ref.path, data });
        },
        set: (ref: { path: string }, data: Doc) => writes.push({ kind: "set", path: ref.path, data }),
        update: (ref: { path: string }, data: Doc) => writes.push({ kind: "update", path: ref.path, data }),
      };
      try {
        const result = await callback(tx);
        for (const write of writes) {
          if (write.kind === "update") state.docs.set(write.path, { ...state.docs.get(write.path), ...write.data });
          else state.docs.set(write.path, write.data);
        }
        return result;
      } finally {
        release();
      }
    },
  };
}

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
    state.docs.clear();
    state.queue = Promise.resolve();
    state.available = true;
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
    const first = await supertest(app).post("/api/volunteer/register").set("x-forwarded-for", nextIp()).send({
      fullName: "مختبر حماية",
      phone: VALID_PHONE,
      wilaya: "الجزائر - البليدة",
    });
    expect(first.status).toBe(200);
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
    state.available = false;
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
