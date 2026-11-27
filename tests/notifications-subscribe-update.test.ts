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
    unsubscribeToken: "u".repeat(64),
  } as Record<string, unknown>,
  updateCalls: [] as Array<Record<string, unknown>>,
  subscriberExists: true,
  setCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../server/firebase.js", () => ({
  getDb: () => ({
    runTransaction: async (callback: (tx: {
      get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> }>;
      update: (_ref: unknown, data: Record<string, unknown>) => void;
      set: (_ref: unknown, data: Record<string, unknown>) => void;
    }) => Promise<unknown>) => callback({
      get: async () => ({ exists: state.subscriberExists, data: () => state.existing }),
      update: (_ref, data) => { state.updateCalls.push(data); },
      set: (_ref, data) => { state.setCalls.push(data); },
    }),
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: state.subscriberExists, data: () => state.existing }),
        update: async (update: Record<string, unknown>) => {
          state.updateCalls.push(update);
        },
        set: async (data: Record<string, unknown>) => {
          state.setCalls.push(data);
        },
      }),
    }),
  }),
  isAdminDb: () => state.adminSdk,
}));

vi.mock("firebase/firestore", () => ({
  runTransaction: async (_db: unknown, callback: (tx: {
    get: () => Promise<{ exists: () => boolean; data: () => Record<string, unknown> }>;
    update: (_ref: unknown, data: Record<string, unknown>) => void;
    set: (_ref: unknown, data: Record<string, unknown>) => void;
  }) => Promise<unknown>) => callback({
    get: async () => ({ exists: () => state.subscriberExists, data: () => state.existing }),
    update: (_ref, data) => { state.updateCalls.push(data); },
    set: (_ref, data) => { state.setCalls.push(data); },
  }),
  doc: () => ({}),
  getDoc: async () => ({ exists: () => state.subscriberExists, data: () => state.existing }),
  updateDoc: async (_ref: unknown, update: Record<string, unknown>) => {
    state.updateCalls.push(update);
  },
  setDoc: async (_ref: unknown, data: Record<string, unknown>) => {
    state.setCalls.push(data);
  },
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
  // Fix 44 (MAIL-3): trust one proxy hop so X-Forwarded-For drives req.ip —
  // the subscribe limiter (10/min) is shared across this file's tests, and
  // the MAIL-3 tests need fresh buckets (sos-ip-flood.test.ts precedent).
  app.set("trust proxy", 1);
  app.use("/api/notifications", notificationsRouter);
  return app;
}

describe("notification subscribe — verified subscriber preference repair (Fix 8c)", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

  beforeEach(() => {
    state.adminSdk = true;
    state.existing = { verified: true, wilayas: ["Annaba"], minSeverity: "low", unsubscribeToken: "u".repeat(64) };
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
          // Fix 8e: the verified-update path requires the stored
          // unsubscribeToken as proof of mailbox control.
          token: "u".repeat(64),
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
        .send({ email: "citizen@example.com", minSeverity: "medium", token: "u".repeat(64) });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Subscription preferences updated.");
      expect(state.updateCalls).toHaveLength(1);
      expect(state.updateCalls[0].wilayas).toEqual([]);
      expect(state.updateCalls[0].minSeverity).toBe("medium");
    },
  );
});

describe("notification subscribe — verified updates require mailbox control (Fix 8e, CWE-862)", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

  beforeEach(() => {
    state.adminSdk = true;
    state.existing = { verified: true, wilayas: ["Annaba"], minSeverity: "low", unsubscribeToken: "u".repeat(64) };
    state.updateCalls = [];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "rejects a verified preference update with no token (admin SDK: %s)",
    async (adminSdk) => {
      state.adminSdk = adminSdk;
      const res = await supertest(createApp())
        .post("/api/notifications/subscribe")
        .send({ email: "citizen@example.com", minSeverity: "critical" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Invalid unsubscribe token");
      expect(state.updateCalls).toHaveLength(0);
    },
  );

  it.each([true, false])(
    "rejects a verified preference update with the wrong token (admin SDK: %s)",
    async (adminSdk) => {
      state.adminSdk = adminSdk;
      const res = await supertest(createApp())
        .post("/api/notifications/subscribe")
        .send({ email: "citizen@example.com", minSeverity: "critical", token: "w".repeat(64) });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Invalid unsubscribe token");
      expect(state.updateCalls).toHaveLength(0);
    },
  );

  it.each([true, false])(
    "an unverified re-subscribe still takes the verification flow with no token (admin SDK: %s)",
    async (adminSdk) => {
      state.adminSdk = adminSdk;
      state.existing = { verified: false, wilayas: [], minSeverity: "medium", unsubscribeToken: "u".repeat(64) };
      const res = await supertest(createApp())
        .post("/api/notifications/subscribe")
        .send({ email: "citizen@example.com", minSeverity: "high" });

      // No token is needed here: mailbox control is proven by the fresh
      // verification this path issues — the update re-issues a verification
      // token + expiry + unsubscribe token and keeps verified false, instead
      // of applying the preferences directly. (Fix 44 MAIL-3: no email
      // provider is configured in this env, so the response says so instead
      // of promising a verification email.)
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Subscription saved, but email delivery is not configured — you will not receive a verification email.");
      expect(res.body.emailDelivery).toBe("disabled");
      expect(state.updateCalls).toHaveLength(1);
      const update = state.updateCalls[0];
      expect(update.verified).toBe(false);
      expect(typeof update.verificationToken).toBe("string");
      expect(update.verificationToken).toHaveLength(64);
      expect(typeof update.verificationExpiresAt).toBe("string");
      expect(typeof update.unsubscribeToken).toBe("string");
      expect(update.unsubscribeToken).toHaveLength(64);
    },
  );
});

describe("notification subscribe — unconfigured mail (Fix 44, MAIL-3)", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

  beforeEach(() => {
    state.adminSdk = true;
    state.subscriberExists = false;
    state.setCalls = [];
    state.updateCalls = [];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a fresh subscription with no mail provider says so instead of promising a verification email", async () => {
    // No provider keys are set in this file's env, so sendVerificationEmail
    // returns "not-configured" — the default here.
    const res = await supertest(createApp())
      .post("/api/notifications/subscribe")
      .set("X-Forwarded-For", "10.44.0.1")
      .send({ email: "new-subscriber@example.com", wilayas: ["الجزائر - عنابة (Algérie - Annaba)"], minSeverity: "medium" });

    expect(res.status).toBe(200);
    expect(res.body.emailDelivery).toBe("disabled");
    expect(res.body.message).toBe("Subscription saved, but email delivery is not configured — you will not receive a verification email.");
    // The record is still persisted, unverified.
    expect(state.setCalls).toHaveLength(1);
    expect(state.setCalls[0].verified).toBe(false);
    expect(typeof state.setCalls[0].verificationToken).toBe("string");
    // And no verification email was attempted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with a provider configured the original verification message returns and no emailDelivery field appears", async () => {
    // config reads process.env at import time (server/config.ts:91-93), so
    // the control needs a fresh router import AFTER stubbing the key.
    vi.stubEnv("RESEND_API_KEY", "test-key");
    try {
      vi.resetModules();
      const { default: freshRouter } = await import("../server/routes/notifications.js");
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use(cookieParser());
      freshApp.set("trust proxy", 1);
      freshApp.use("/api/notifications", freshRouter);

      const res = await supertest(freshApp)
        .post("/api/notifications/subscribe")
        .set("X-Forwarded-For", "10.44.0.2")
        .send({ email: "configured@example.com", wilayas: ["الجزائر - عنابة (Algérie - Annaba)"], minSeverity: "medium" });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Subscription created. Check email to verify.");
      expect(res.body).not.toHaveProperty("emailDelivery");
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
