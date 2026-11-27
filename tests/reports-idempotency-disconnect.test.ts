import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// CodeRabbit (PR #215, Major, finding 9): if the client disconnected
// during the durable idempotency lookup, res 'close' fired before the
// release listeners were registered, and a later rejection on the dead
// socket emitted neither 'finish' nor another 'close' — the pending entry
// leaked and a same-key retry hung on its promise forever. This test
// reproduces that exact sequence: disconnect mid-lookup, invalid image,
// then a same-key retry that must complete instead of hanging.
const mockState = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  lookupGate: null as null | {
    promise: Promise<{ status: string }>;
    called: Promise<void>;
    notifyCalled: () => void;
  },
  aiGate: null as null | {
    promise: Promise<{ text: string }>;
    called: Promise<void>;
    notifyCalled: () => void;
  },
}));

vi.mock("../server/db.js", async (importOriginal) => ({
  getReportsDbResult: vi.fn(async () => ({ status: "ok", reports: [] })),
  getPublicReportsWire: vi.fn(async () => ({ status: "ok", reports: [] })),
  getReportImageDataUrl: vi.fn(async () => null),
  getReportPrivate: vi.fn(async () => null),
  sanitizePublicReport: (report: any) => {
    if (!report) return report;
    const { reporterPhone: _rp, reporterName: _rn, reporterBadgeCode: _rbc, deviceId: _did, image: _img, ...safe } = report;
    if (safe.hasImage === undefined && typeof report.image === "string" && report.image.length > 0) safe.hasImage = true;
    return safe;
  },
  seedReportsToFirestore: vi.fn(async () => true),
  // No gate: exercise the real lookup against the memory Firestore, so
  // a retry that waits on a pending entry can actually find the report
  // the original saved (a stubbed "missing" would 503 instead of 200).
  lookupReportIdempotency: async (_id: string) => {
    const gate = mockState.lookupGate;
    if (gate) {
      gate.notifyCalled();
      return gate.promise;
    }
    return (await importOriginal<typeof import("../server/db.js")>()).lookupReportIdempotency(_id);
  },
  // Exercise the actual transactional save, not a replica here.
  saveReportWithIdempotency: (await importOriginal<typeof import("../server/db.js")>()).saveReportWithIdempotency,
  confirmReportInFirestore: vi.fn(async () => ({ status: "no_db" })),
  updateReportInFirestore: vi.fn(async () => true),
}));

vi.mock("../server/firebase.js", async () => {
  const { memoryAdminDb } = await import("./helpers/memoryAdminDb");
  const db = memoryAdminDb(mockState.docs);
  return { getDb: () => db, isAdminDb: () => true };
});

vi.mock("express-rate-limit", () => ({
  default: () => (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../server/fs.js", () => ({
  docUpdate: async () => true,
}));

vi.mock("../server/ai.js", () => ({
  // Without an AI gate the handler skips vision analysis entirely; with
  // one it awaits the gated generateContent, so a test can disconnect the
  // client mid-AI-call.
  getAiClient: () => {
    const gate = mockState.aiGate;
    if (!gate) return null;
    return {
      models: {
        generateContent: async () => {
          gate.notifyCalled();
          return gate.promise;
        },
      },
    };
  },
  getAiModel: () => "gemini-3-flash-preview",
}));

const emailSpy = vi.hoisted(() => ({ sendFireAlert: vi.fn(async (_report: any) => {}) }));
vi.mock("../server/email.js", () => ({
  sendFireAlert: emailSpy.sendFireAlert,
}));

const { default: reportsRouter } = await import("../server/routes/reports.js");

function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/reports", reportsRouter);
  return app;
}

describe("POST /api/reports — idempotency entry release on disconnect", () => {
  beforeEach(() => {
    mockState.docs.clear();
    mockState.lookupGate = null;
    mockState.aiGate = null;
  });

  it("releases the pending entry when the client disconnects during the lookup and the image is then rejected", async () => {
    const app = createApp();
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;

      // Gate the first durable lookup so the test controls its timing.
      let notifyCalled!: () => void;
      const called = new Promise<void>((resolve) => {
        notifyCalled = resolve;
      });
      let resolveLookup!: (value: { status: string }) => void;
      const lookupPromise = new Promise<{ status: string }>((resolve) => {
        resolveLookup = resolve;
      });
      mockState.lookupGate = { promise: lookupPromise, called, notifyCalled };

      const body = {
        lat: 36.8,
        lng: 7.6,
        locationName: "غابة سيريدي",
        wilaya: "الجزائر - عنابة (Algérie - Annaba)",
        description: "حريق غابة اختبار لتحرير إدخال عدم التكرار عند انقطاع العميل",
        severity: "medium",
        reporterType: "citizen",
        clientGeneratedId: "cg-disconnect-0001",
        // Not real image magic bytes — the image gate rejects this after
        // the idempotency entry is installed.
        image: "data:image/jpeg;base64,aGVsbG8=",
      };

      // First attempt over a raw socket, destroyed while the lookup is
      // still pending: res 'close' fires before the release listeners
      // exist, so only the try/finally can release the entry.
      const req1 = http.request(
        { host: "127.0.0.1", port, path: "/api/reports", method: "POST", headers: { "content-type": "application/json" } },
        () => {},
      );
      req1.on("error", () => {});
      req1.write(JSON.stringify(body));
      req1.end();
      await called;
      req1.destroy();
      await new Promise((resolve) => setTimeout(resolve, 200));
      resolveLookup({ status: "missing" });
      mockState.lookupGate = null;
      // Let the handler run: install the entry, reject the image on the
      // dead socket, return — and release the entry in the finally.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Same-key retry with a corrected (imageless) submission: the
      // fingerprint excludes the image, so this is the same logical
      // submission. Without the fix it hangs on the leaked entry's
      // promise; with the fix it completes and creates the report.
      const { image: _badImage, ...retryBody } = body;
      const res = await supertest(app).post("/api/reports").send(retryBody).timeout(5000);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(typeof res.body.id).toBe("string");
    } finally {
      server.close();
    }
  });

  // CodeRabbit (PR #215, R2-#2): the `close` listener used to delete the
  // in-flight entry when the client disconnected during AI processing, so
  // a same-key retry found no entry and no durable report yet, reached the
  // spatial-dedupe check against the original's still-live reservation,
  // and got 409 DUPLICATE_SPATIAL_REPORT instead of the original result.
  // With the listener removed the entry is held until the handler
  // completes, so the retry waits on it and receives the original report.
  it("a retry during AI processing waits for the original instead of 409", async () => {
    const app = createApp();
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;

      // Gate the AI call so the test controls its timing.
      let notifyAiCalled!: () => void;
      const aiCalled = new Promise<void>((resolve) => {
        notifyAiCalled = resolve;
      });
      let resolveAi!: (value: { text: string }) => void;
      const aiPromise = new Promise<{ text: string }>((resolve) => {
        resolveAi = resolve;
      });
      mockState.aiGate = { promise: aiPromise, called: aiCalled, notifyCalled: notifyAiCalled };

      const body = {
        lat: 36.9,
        lng: 7.7,
        locationName: "غابة سيريدي",
        wilaya: "الجزائر - عنابة (Algérie - Annaba)",
        description: "حريق غابة اختبار لإعادة المحاولة أثناء معالجة الذكاء الاصطناعي",
        severity: "medium",
        reporterType: "citizen",
        clientGeneratedId: "cg-disconnect-ai-0001",
        // Real JPEG magic bytes (FF D8 FF) so the image gate passes and
        // the handler reaches the AI call.
        image: "data:image/jpeg;base64,/9j/",
      };

      // First attempt over a raw socket, destroyed while the AI call is
      // still pending: res 'close' fires with the entry installed.
      const req1 = http.request(
        { host: "127.0.0.1", port, path: "/api/reports", method: "POST", headers: { "content-type": "application/json" } },
        () => {},
      );
      req1.on("error", () => {});
      req1.write(JSON.stringify(body));
      req1.end();
      await aiCalled;
      req1.destroy();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Same-key retry while the original is still awaiting AI: with the
      // fix it finds the pending entry and waits; without it the entry is
      // gone and the retry 409s on the original's live reservation.
      // NB: supertest is lazy — the request only starts once .then is
      // attached, so attach it here to send the retry while the original
      // is still awaiting AI.
      const retryPromise = supertest(app).post("/api/reports").send(body).timeout(5000).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 200));
      resolveAi({
        text: JSON.stringify({
          isVerified: false,
          confidence: 10,
          detectedSigns: [],
          aiComments: "",
          suggestedSeverity: "LOW",
        }),
      });
      const res = await retryPromise;
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(typeof res.body.id).toBe("string");
    } finally {
      server.close();
    }
  });
});
