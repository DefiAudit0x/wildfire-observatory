import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { vi } from "vitest";

const mockDocs = vi.hoisted(() => new Map<string, any>());

vi.mock("express-rate-limit", () => ({
  default: () => (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../server/atomic.js", () => ({
  createDocIfAbsent: async (collection: string, id: string, data: any) => {
    const key = `${collection}/${id}`;
    if (mockDocs.has(key)) return "exists";
    mockDocs.set(key, { ...data });
    return "created";
  },
}));

vi.mock("../server/fs.js", () => ({
  collectionGet: async (collection: string) =>
    Array.from(mockDocs.entries())
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([key, value]) => ({ id: key.split("/")[1], ...value })),
  docSet: async (collection: string, id: string, data: any) => {
    mockDocs.set(`${collection}/${id}`, { ...data });
    return true;
  },
  docUpdate: async (collection: string, id: string, data: any) => {
    const key = `${collection}/${id}`;
    const current = mockDocs.get(key) || {};
    mockDocs.set(key, { ...current, ...data });
    return true;
  },
  docDelete: async (collection: string, id: string) => {
    mockDocs.delete(`${collection}/${id}`);
    return true;
  },
}));

vi.mock("../server/middleware.js", () => ({
  requireAdmin: (req: any, res: any, next: () => void) => {
    const authHeader = req?.headers?.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  },
  verifyAdminToken: () => ({ valid: true, role: "admin" }),
}));

vi.mock("../server/routes/admin.js", () => ({
  verifyAdminPassword: async (password: string) => password === "admin-secret",
}));

const { default: badgesRouter } = await import("../server/routes/badges.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/badges", badgesRouter);
  return app;
}

beforeEach(() => {
  mockDocs.clear();
});

function seedBadge(overrides: Record<string, any> = {}) {
  const doc = {
    ownerName: "مختبر",
    type: "volunteer",
    wilaya: "الجزائر - عنابة (Algérie - Annaba)",
    isActive: true,
    usedCount: 3,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  const code = overrides.code || "VOL-001";
  mockDocs.set(`badgeCodes/${code}`, doc);
  return { code, doc };
}

describe("POST /api/badges", () => {
  it("creates a badge with admin token", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/badges")
      .set("Authorization", "Bearer fake-token")
      .send({ code: "VOL-002", ownerName: "أحمد", type: "volunteer", wilaya: "الجزائر - عنابة (Algérie - Annaba)", maxUses: 5, expiresAt: "2027-01-01T00:00:00" });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("VOL-002");
    expect(res.body.isActive).toBe(true);
    expect(res.body.maxUses).toBe(5);
    const stored = mockDocs.get("badgeCodes/VOL-002");
    expect(stored.usedCount).toBe(0);
  });

  it("rejects an already existing code", async () => {
    seedBadge();
    const app = createApp();
    const res = await supertest(app)
      .post("/api/badges")
      .set("Authorization", "Bearer fake-token")
      .send({ password: "admin-secret", code: "VOL-001", ownerName: "أحمد", type: "volunteer", wilaya: "الجزائر - عنابة (Algérie - Annaba)" });
    expect(res.status).toBe(409);
  });

  it("rejects unauthorized requests (no token, wrong password)", async () => {
    const app = createApp();
    const res = await supertest(app)
      .post("/api/badges")
      .send({ password: "wrong", code: "VOL-003", ownerName: "أحمد", type: "volunteer", wilaya: "الجزائر - عنابة (Algérie - Annaba)" });
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/badges/:code", () => {
  it("updates limits and invalidates trust cache", async () => {
    seedBadge();
    const app = createApp();
    const res = await supertest(app)
      .put("/api/badges/VOL-001")
      .set("Authorization", "Bearer fake-token")
      .send({ password: "admin-secret", maxUses: 10, expiresAt: "2027-06-01T00:00:00", wilaya: "الجزائر - تلمسان (Algérie - Tlemcen)" });
    expect(res.status).toBe(200);
    expect(res.body.maxUses).toBe(10);
    expect(res.body.wilaya).toBe("الجزائر - تلمسان (Algérie - Tlemcen)");
    expect(mockDocs.get("badgeCodes/VOL-001").maxUses).toBe(10);
  });

  it("returns 404 for unknown badge", async () => {
    const app = createApp();
    const res = await supertest(app)
      .put("/api/badges/NOPE")
      .set("Authorization", "Bearer fake-token")
      .send({ password: "admin-secret", maxUses: 3 });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/badges/:code/toggle", () => {
  it("flips isActive", async () => {
    seedBadge();
    const app = createApp();
    const res = await supertest(app)
      .post("/api/badges/VOL-001/toggle")
      .set("Authorization", "Bearer fake-token")
      .send({ password: "admin-secret" });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    const res2 = await supertest(app)
      .post("/api/badges/VOL-001/toggle")
      .set("Authorization", "Bearer fake-token")
      .send({ password: "admin-secret" });
    expect(res2.body.isActive).toBe(true);
  });
});

describe("DELETE /api/badges/:code", () => {
  it("removes the badge", async () => {
    seedBadge();
    const app = createApp();
    const res = await supertest(app)
      .delete("/api/badges/VOL-001")
      .set("Authorization", "Bearer fake-token")
      .send({ password: "admin-secret" });
    expect(res.status).toBe(200);
    expect(mockDocs.has("badgeCodes/VOL-001")).toBe(false);
  });
});

describe("GET /api/badges/analytics", () => {
  it("aggregates badge statistics", async () => {
    seedBadge({ code: "VOL-001", type: "volunteer", wilaya: "الجزائر - عنابة (Algérie - Annaba)", isActive: true, usedCount: 3, maxUses: 5 });
    seedBadge({ code: "OFF-001", type: "official", wilaya: "الجزائر - عنابة (Algérie - Annaba)", isActive: true, usedCount: 10, maxUses: 10 });
    seedBadge({ code: "VOL-002", type: "volunteer", wilaya: "الجزائر - وهران (Algérie - Oran)", isActive: false, usedCount: 1 });
    seedBadge({ code: "OLD-001", type: "volunteer", wilaya: "الجزائر - عنابة (Algérie - Annaba)", isActive: true, expiresAt: "2020-01-01T00:00:00", usedCount: 2 });
    const app = createApp();
    const res = await supertest(app)
      .get("/api/badges/analytics")
      .set("Authorization", "Bearer fake-token");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.active).toBe(1);
    expect(res.body.inactive).toBe(1);
    expect(res.body.expired).toBe(1);
    expect(res.body.capReached).toBe(1);
    expect(res.body.totalUsage).toBe(16);
    expect(res.body.byWilaya["الجزائر - عنابة (Algérie - Annaba)"]).toBe(3);
    expect(res.body.byType.volunteer).toBe(3);
    expect(res.body.byType.official).toBe(1);
    expect(res.body.topUsed[0].code).toBe("OFF-001");
    expect(res.body.topUsed[0].usedCount).toBe(10);
  });
});

describe("GET /api/badges", () => {
  it("returns all badges with code fields", async () => {
    seedBadge();
    const app = createApp();
    const res = await supertest(app)
      .get("/api/badges")
      .set("Authorization", "Bearer fake-token");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].code).toBe("VOL-001");
    expect(res.body[0].ownerName).toBe("مختبر");
  });
});