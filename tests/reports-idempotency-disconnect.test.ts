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
  lookupReportIdempotency: vi.fn(async (_id: string) => {
    const gate = mockState.lookupGate;
    if (gate) {
      gate.notifyCalled();
      return gate.promise;
    }
    return { status: "missing" };
  }),
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
  getAiClient: () => null,
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
});
