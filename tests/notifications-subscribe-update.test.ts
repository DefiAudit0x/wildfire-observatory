import express from "express";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cookieParser from "cookie-parser";

const state = vi.hoisted(() => ({
  adminSdk: true,
  existing: {
    verified: true,
    wilayas: ["Annaba"],
    minSeverity: "low",
  } as Record<string, unknown>,
  updateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../server/firebase.js", () => ({
  getDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => state.existing }),
        update: async (update: Record<string, unknown>) => {
          state.updateCalls.push(update);
        },
        set: async () => {},
      }),
    }),
  }),
  isAdminDb: () => state.adminSdk,
}));

vi.mock("firebase/firestore", () => ({
  doc: () => ({}),
  getDoc: async () => ({ exists: () => true, data: () => state.existing }),
  updateDoc: async (_ref: unknown, update: Record<string, unknown>) => {
    state.updateCalls.push(update);
  },
  setDoc: async () => {},
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: async () => ({ forEach: () => {} }),
}));

import notificationsRouter from "../server/routes/notifications.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/notifications", notificationsRouter);
  return app;
}

describe("notification subscribe — verified subscriber preference repair (Fix 8c)", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

  beforeEach(() => {
    state.adminSdk = true;
    state.existing = { verified: true, wilayas: ["Annaba"], minSeverity: "low" };
    state.updateCalls = [];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "lets a verified subscriber update preferences without re-verifying (admin SDK: %s)",
    async (adminSdk) => {
      state.adminSdk = adminSdk;
      const res = await supertest(createApp())
        .post("/api/notifications/subscribe")
        .send({
          email: "citizen@example.com",
          wilayas: ["الجزائر - عنابة (Algérie - Annaba)"],
          minSeverity: "high",
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Subscription preferences updated.");
      expect(state.updateCalls).toHaveLength(1);
      const update = state.updateCalls[0];
      expect(update.wilayas).toEqual(["الجزائر - عنابة (Algérie - Annaba)"]);
      expect(update.minSeverity).toBe("high");
      expect(update.updatedAt).toEqual(expect.any(String));
      // The repair must not touch verification state: no re-verification
      // token, no new unsubscribe token, no verified flag flip.
      expect(update).not.toHaveProperty("verified");
      expect(update).not.toHaveProperty("verificationToken");
      expect(update).not.toHaveProperty("unsubscribeToken");
      // And no verification email is issued for an already-verified email.
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "omitted wilayas reset a verified subscriber to all regions (admin SDK: %s)",
    async (adminSdk) => {
      state.adminSdk = adminSdk;
      const res = await supertest(createApp())
        .post("/api/notifications/subscribe")
        .send({ email: "citizen@example.com", minSeverity: "medium" });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Subscription preferences updated.");
      expect(state.updateCalls).toHaveLength(1);
      expect(state.updateCalls[0].wilayas).toEqual([]);
      expect(state.updateCalls[0].minSeverity).toBe("medium");
    },
  );
});
