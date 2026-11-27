/**
 * v2.4.0 — S-H1/S-H2 privacy split: real server/db.ts logic against a fake
 * ADMIN Firestore (the only mode where writes happen). Covers:
 *   - splitReportForPrivacy: identity/photo leave the public doc
 *   - sanitizePublicReport: wire shape (no PII, no inline image, hasImage)
 *   - scrubLegacyReportFields + migration of pre-split rows on read
 *   - saveReportWithIdempotency: one atomic transaction writes all shards
 *   - purgeReportWithIdempotency: shards die WITH the report
 *   - getReportImageDataUrl: shard first, legacy inline fallback
 *   - getPublicReportsWire: validation gate + sanitized wire
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type DocData = Record<string, any>;

function makeFakeAdminDb(existing: Record<string, DocData>) {
  const deleted: string[] = [];
  const written: Record<string, DocData> = {};

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      __path: path,
      collection: (name: string) => queryRef(`${path}/${name}`),
      get: async () => ({
        exists: existing[path] !== undefined,
        data: () => existing[path],
        id,
      }),
      set: async (data: DocData) => {
        written[path] = data;
        existing[path] = data;
      },
      delete: async () => {
        deleted.push(path);
        delete existing[path];
      },
    };
  };

  const queryRef = (col: string, filter?: { field: string; value: any }) => ({
    __query: true,
    __col: col,
    __filter: filter,
    limit: () => queryRef(col, filter),
    get: async () => {
      const docs = Object.entries(existing)
        .filter(([path, data]) => path.startsWith(`${col}/`) && !path.slice(col.length + 1).includes("/") &&
          (!filter || data[filter.field] === filter.value))
        .map(([path, data]) => ({ id: path.split("/").at(-1), ref: { __path: path }, data: () => data, exists: true }));
      return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb: (d: any) => void) => docs.forEach(cb) };
    },
  });

  const db: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (field: string, _op: string, value: any) => queryRef(col, { field, value }),
      orderBy: () => ({
        limit: () => queryRef(col),
        startAfter: () => queryRef(col),
      }),
    }),
    batch: () => {
      const ops: string[] = [];
      return {
        delete: (ref: any) => ops.push(ref.__path),
        commit: async () => {
          for (const path of ops) {
            deleted.push(path);
            delete existing[path];
          }
        },
      };
    },
    runTransaction: async (fn: (tx: any) => any) => fn({
      get: async (ref: any) => ref.__query
        ? queryRef(ref.__col, ref.__filter).get()
        : { exists: existing[ref.__path] !== undefined, data: () => existing[ref.__path], id: ref.__path.split("/")[1] },
      set: (ref: { __path: string }, data: DocData) => {
        written[ref.__path] = data;
        existing[ref.__path] = data;
      },
      create: (ref: any, data: DocData) => {
        if (existing[ref.__path] !== undefined) throw new Error("doc already exists");
        written[ref.__path] = data;
        existing[ref.__path] = data;
      },
      update: (ref: any, data: DocData) => { Object.assign(existing[ref.__path] ??= {}, data); },
    }),
  };

  return { db, deleted, written, docs: existing };
}

const state = vi.hoisted(() => ({ fake: null as any, clientMode: false }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => state.fake?.db ?? null,
  isAdminDb: () => state.fake !== null && !state.clientMode,
}));

// Fix 44 (DB-2 scope expansion): the client-SDK surface the purge client
// branch rides — reads/writes the same fake store as the admin fake above,
// so the client-branch purge test asserts against one shared store.
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, collection: string, id: string) => ({ id, __path: `${collection}/${id}`, path: `${collection}/${id}` }),
  collection: (_db: unknown, ...segments: string[]) => ({ __col: segments.join("/") }),
  where: (field: string, _op: string, value: any) => ({ field, value }),
  query: (col: { __col: string }, filter?: { field: string; value: any }) => ({ __col: col.__col, __filter: filter }),
  getDoc: async (ref: { __path: string }) => ({
    exists: () => state.fake?.docs[ref.__path] !== undefined,
    data: () => state.fake?.docs[ref.__path],
    id: ref.__path.split("/")[1],
  }),
  getDocs: async (q: { __col: string; __filter?: { field: string; value: any } }) => {
    const docs = Object.entries(state.fake?.docs ?? {})
      .filter(([path, data]: [string, any]) => path.startsWith(`${q.__col}/`) && !path.slice(q.__col.length + 1).includes("/") &&
        (!q.__filter || data[q.__filter.field] === q.__filter.value))
      .map(([path, data]: [string, any]) => ({ id: path.split("/").at(-1), ref: { __path: path }, data: () => data }));
    return { docs, empty: docs.length === 0, forEach: (cb: (d: any) => void) => docs.forEach(cb) };
  },
  writeBatch: () => {
    const ops: string[] = [];
    return {
      delete: (ref: { __path: string }) => ops.push(ref.__path),
      commit: async () => {
        for (const path of ops) {
          state.fake.deleted.push(path);
          delete state.fake.docs[path];
        }
      },
    };
  },
}));

import {
  splitReportForPrivacy,
  sanitizePublicReport,
  getReportsDbResult,
  getPublicReportsWire,
  getReportImageDataUrl,
  getReportPrivate,
  saveReportWithIdempotency,
  purgeReportWithIdempotency,
  invalidateReportsCache,
} from "../server/db.js";

const PII_REPORT = {
  id: "rep-privacy-1",
  lat: 36.75,
  lng: 7.6,
  locationName: "غابة تازا",
  wilaya: "الجزائر - تيزي وزو",
  description: "ألسنة لهب مرئية من الطريق",
  severity: "high",
  status: "pending",
  reporterType: "citizen",
  reporterName: "مواطن سري",
  reporterPhone: "+213661000000",
  reporterBadgeCode: "badge-9",
  deviceId: "device-abc",
  image: "data:image/jpeg;base64,AAAAJPGDATA",
  timestamp: new Date().toISOString(),
  consensusCount: 1,
  clientGeneratedId: "cg-privacy-1",
};

beforeEach(() => {
  invalidateReportsCache();
  state.fake = null;
  state.clientMode = false;
});

describe("splitReportForPrivacy — S-H1 shard split", () => {
  it("moves identity to the private shard and the photo out of the public doc", () => {
    const { publicDoc, privateDoc, imageDataUrl } = splitReportForPrivacy({ ...PII_REPORT });
    expect(publicDoc.id).toBe("rep-privacy-1");
    expect(publicDoc.locationName).toBe("غابة تازا");
    expect(publicDoc.hasImage).toBe(true);
    expect(publicDoc.reporterName).toBeUndefined();
    expect(publicDoc.reporterPhone).toBeUndefined();
    expect(publicDoc.reporterBadgeCode).toBeUndefined();
    expect(publicDoc.deviceId).toBeUndefined();
    expect(publicDoc.image).toBeUndefined();
    expect(privateDoc).toEqual({
      reportId: "rep-privacy-1",
      reporterName: "مواطن سري",
      reporterPhone: "+213661000000",
      reporterBadgeCode: "badge-9",
      deviceId: "device-abc",
    });
    expect(imageDataUrl).toBe("data:image/jpeg;base64,AAAAJPGDATA");
  });

  it("returns no private shard when the reporter submitted zero identity", () => {
    const anonymous = {
      id: "rep-anon", lat: 36.7, lng: 7.5, locationName: "x", wilaya: "y",
      description: "z", severity: "low", status: "pending",
      timestamp: new Date().toISOString(), consensusCount: 1,
    };
    const { privateDoc, imageDataUrl } = splitReportForPrivacy({ ...anonymous });
    expect(privateDoc).toBeNull();
    expect(imageDataUrl).toBeNull();
  });
});

describe("sanitizePublicReport — S-H2 wire contract", () => {
  it("strips PII AND the inline image, sets hasImage for legacy inline rows", () => {
    const safe = sanitizePublicReport({ ...PII_REPORT });
    expect(safe.reporterPhone).toBeUndefined();
    expect(safe.reporterName).toBeUndefined();
    expect(safe.reporterBadgeCode).toBeUndefined();
    expect(safe.deviceId).toBeUndefined();
    expect(safe.image).toBeUndefined();
    expect(safe.hasImage).toBe(true);
  });

  it("keeps a split wire row untouched (hasImage already set)", () => {
    const safe = sanitizePublicReport({ id: "r1", hasImage: true, lat: 1, lng: 2 });
    expect(safe.hasImage).toBe(true);
  });
});

describe("saveReportWithIdempotency — one transaction writes all shards", () => {
  it("public doc carries zero PII/photo; private + image shards are written", async () => {
    const fake = makeFakeAdminDb({});
    state.fake = fake;

    const result = await saveReportWithIdempotency({ ...PII_REPORT }, "fp-privacy-1", () => "fp-privacy-1");
    expect(result.status).toBe("saved");

    const publicDoc = fake.written["reports/rep-privacy-1"];
    expect(publicDoc).toBeDefined();
    expect(publicDoc.reporterPhone).toBeUndefined();
    expect(publicDoc.reporterName).toBeUndefined();
    expect(publicDoc.deviceId).toBeUndefined();
    expect(publicDoc.image).toBeUndefined();
    expect(publicDoc.hasImage).toBe(true);

    expect(fake.written["reportPrivate/rep-privacy-1"]).toMatchObject({
      reportId: "rep-privacy-1",
      deviceId: "device-abc",
      reporterPhone: "+213661000000",
    });
    expect(fake.written["reportImages/rep-privacy-1"].image).toBe("data:image/jpeg;base64,AAAAJPGDATA");
    expect(fake.written["reportIdempotency/cg-privacy-1"].reportId).toBe("rep-privacy-1");
  });
});

describe("purgeReportWithIdempotency — shards die WITH the report", () => {
  it("deletes reports, reportPrivate, reportImages and the idempotency key", async () => {
    const fake = makeFakeAdminDb({
      "reports/rep-privacy-1": { lat: 36.75, lng: 7.6, clientGeneratedId: "cg-privacy-1" },
      "reportPrivate/rep-privacy-1": { deviceId: "device-abc" },
      "reportImages/rep-privacy-1": { image: "data:image/jpeg;base64,AAAA" },
      "reportIdempotency/cg-privacy-1": { reportId: "rep-privacy-1" },
      "reports/rep-privacy-1/confirmations/principal-a": { at: 1 },
      "reports/rep-privacy-1/confirmations/principal-b": { at: 2 },
      "reports/other/confirmations/principal-a": { at: 3 },
    });
    state.fake = fake;

    const outcome = await purgeReportWithIdempotency("rep-privacy-1");
    expect(outcome).toBe("deleted");
    expect(fake.deleted).toContain("reports/rep-privacy-1");
    expect(fake.deleted).toContain("reportPrivate/rep-privacy-1");
    expect(fake.deleted).toContain("reportImages/rep-privacy-1");
    expect(fake.deleted).toContain("reportIdempotency/cg-privacy-1");
    expect(fake.deleted).toContain("reports/rep-privacy-1/confirmations/principal-a");
    expect(fake.deleted).toContain("reports/rep-privacy-1/confirmations/principal-b");
    expect(Object.keys(fake.docs).filter((path) => path.startsWith("reports/rep-privacy-1/"))).toEqual([]);
    expect(fake.docs["reports/other/confirmations/principal-a"]).toEqual({ at: 3 });
  });

  it("client-branch purge deletes the shards too (Fix 44, DB-2 scope expansion)", async () => {
    const fake = makeFakeAdminDb({
      "reports/rep-privacy-1": { lat: 36.75, lng: 7.6, clientGeneratedId: "cg-privacy-1" },
      "reportPrivate/rep-privacy-1": { deviceId: "device-abc" },
      "reportImages/rep-privacy-1": { image: "data:image/jpeg;base64,AAAA" },
      "reportIdempotency/cg-privacy-1": { reportId: "rep-privacy-1" },
      "reports/rep-privacy-1/confirmations/principal-a": { at: 1 },
      "reports/rep-privacy-1/confirmations/principal-b": { at: 2 },
      "reports/other/confirmations/principal-a": { at: 3 },
    });
    state.fake = fake;
    state.clientMode = true;

    const outcome = await purgeReportWithIdempotency("rep-privacy-1");
    expect(outcome).toBe("deleted");
    expect(fake.deleted).toContain("reports/rep-privacy-1");
    expect(fake.deleted).toContain("reportPrivate/rep-privacy-1");
    expect(fake.deleted).toContain("reportImages/rep-privacy-1");
    expect(fake.deleted).toContain("reportIdempotency/cg-privacy-1");
    expect(fake.deleted).toContain("reports/rep-privacy-1/confirmations/principal-a");
    expect(fake.deleted).toContain("reports/rep-privacy-1/confirmations/principal-b");
    expect(Object.keys(fake.docs).filter((path) => path.startsWith("reports/rep-privacy-1/"))).toEqual([]);
    expect(fake.docs["reports/other/confirmations/principal-a"]).toEqual({ at: 3 });
  });

  // CodeRabbit (PR #215, R2-#1): a previous purge deleted the parent and
  // then failed in the straggler pass — the confirmations survive under the
  // deleted path. A retry used to return "missing" before any cleanup and
  // orphan them forever. The retry must now delete them first.
  it("a retry after a partial purge still deletes orphaned confirmations", async () => {
    const fake = makeFakeAdminDb({
      "reports/rep-orphan/confirmations/principal-a": { at: 1 },
      "reports/rep-orphan/confirmations/principal-b": { at: 2 },
      "reports/other/confirmations/principal-a": { at: 3 },
    });
    state.fake = fake;

    const outcome = await purgeReportWithIdempotency("rep-orphan");
    expect(outcome).toBe("missing");
    expect(fake.deleted).toContain("reports/rep-orphan/confirmations/principal-a");
    expect(fake.deleted).toContain("reports/rep-orphan/confirmations/principal-b");
    expect(Object.keys(fake.docs).filter((path) => path.startsWith("reports/rep-orphan/"))).toEqual([]);
    expect(fake.docs["reports/other/confirmations/principal-a"]).toEqual({ at: 3 });
  });

  it("a retry after a partial purge still deletes orphaned confirmations (client branch)", async () => {
    const fake = makeFakeAdminDb({
      "reports/rep-orphan/confirmations/principal-a": { at: 1 },
      "reports/rep-orphan/confirmations/principal-b": { at: 2 },
      "reports/other/confirmations/principal-a": { at: 3 },
    });
    state.fake = fake;
    state.clientMode = true;

    const outcome = await purgeReportWithIdempotency("rep-orphan");
    expect(outcome).toBe("missing");
    expect(fake.deleted).toContain("reports/rep-orphan/confirmations/principal-a");
    expect(fake.deleted).toContain("reports/rep-orphan/confirmations/principal-b");
    expect(Object.keys(fake.docs).filter((path) => path.startsWith("reports/rep-orphan/"))).toEqual([]);
    expect(fake.docs["reports/other/confirmations/principal-a"]).toEqual({ at: 3 });
  });
});

describe("legacy rows — scrub on read + fire-and-forget migration", () => {
  it("getReportsDbResult scrubs PII/image from a pre-split row and migrates it", async () => {
    state.fake = makeFakeAdminDb({
      "reports/rep-legacy": {
        lat: 36.75, lng: 7.6, locationName: "غابة تازا", wilaya: "w", description: "d",
        severity: "high", status: "pending", reporterType: "citizen",
        reporterName: "مواطن سري", reporterPhone: "+213661000000", reporterBadgeCode: "badge-9",
        deviceId: "device-abc", image: "data:image/jpeg;base64,AAAAJPGDATA",
        timestamp: new Date().toISOString(), consensusCount: 1, clientGeneratedId: "cg-legacy",
      },
    });

    const result = await getReportsDbResult();
    expect(result.status).toBe("ok");
    const row: any = (result as any).reports?.[0];
    expect(row.id).toBe("rep-legacy");
    expect(row.reporterPhone).toBeUndefined();
    expect(row.reporterName).toBeUndefined();
    expect(row.deviceId).toBeUndefined();
    expect(row.image).toBeUndefined();
    expect(row.hasImage).toBe(true);

    // fire-and-forget migration has written the split shards
    await new Promise((r) => setTimeout(r, 25));
    const db2 = state.fake.db;
    const priv = await db2.collection("reportPrivate").doc("rep-legacy").get();
    expect(priv.exists).toBe(true);
    expect(priv.data().deviceId).toBe("device-abc");
    const img = await db2.collection("reportImages").doc("rep-legacy").get();
    expect(img.exists).toBe(true);
    // The migration's final write must scrub the STORED public doc
    // itself — the returned row is scrubbed on read regardless, so only
    // a re-read proves the stored document no longer carries identity
    // or the photo.
    const migrated = await db2.collection("reports").doc("rep-legacy").get();
    expect(migrated.exists).toBe(true);
    expect(migrated.data().reporterPhone).toBeUndefined();
    expect(migrated.data().reporterName).toBeUndefined();
    expect(migrated.data().reporterBadgeCode).toBeUndefined();
    expect(migrated.data().deviceId).toBeUndefined();
    expect(migrated.data().image).toBeUndefined();
    expect(migrated.data().hasImage).toBe(true);
  });
});

describe("getReportImageDataUrl — shard first, legacy fallback", () => {
  it("reads the image shard when present", async () => {
    state.fake = makeFakeAdminDb({
      "reportImages/rep-x": { reportId: "rep-x", image: "data:image/png;base64,SHARD" },
    });
    expect(await getReportImageDataUrl("rep-x")).toBe("data:image/png;base64,SHARD");
  });

  it("falls back to the legacy inline field pre-migration", async () => {
    state.fake = makeFakeAdminDb({
      "reports/rep-y": { image: "data:image/png;base64,LEGACY" },
    });
    expect(await getReportImageDataUrl("rep-y")).toBe("data:image/png;base64,LEGACY");
  });

  it("prefers the shard image when both shard and legacy inline images exist", async () => {
    state.fake = makeFakeAdminDb({
      "reportImages/rep-both": { reportId: "rep-both", image: "data:image/png;base64,SHARD" },
      "reports/rep-both": { image: "data:image/png;base64,LEGACY" },
    });
    expect(await getReportImageDataUrl("rep-both")).toBe("data:image/png;base64,SHARD");
  });

  it("returns null when neither shard nor legacy image exists", async () => {
    state.fake = makeFakeAdminDb({ "reports/rep-z": { lat: 1 } });
    expect(await getReportImageDataUrl("rep-z")).toBeNull();
  });
});

describe("getReportPrivate — identity shard access", () => {
  it("returns the private shard for an admin read", async () => {
    state.fake = makeFakeAdminDb({
      "reportPrivate/rep-p": { reportId: "rep-p", deviceId: "device-9" },
    });
    expect(await getReportPrivate("rep-p")).toMatchObject({ deviceId: "device-9" });
    expect(await getReportPrivate("rep-missing")).toBeNull();
  });
});

describe("getPublicReportsWire — validation gate + sanitized wire", () => {
  it("validates, clusters and sanitizes in one cached pass", async () => {
    state.fake = makeFakeAdminDb({
      "reports/rep-ok": {
        lat: 36.75, lng: 7.6, locationName: "x", wilaya: "y", description: "d",
        severity: "high", status: "pending", reporterType: "citizen",
        reporterPhone: "+213661000000", deviceId: "device-1",
        timestamp: new Date().toISOString(), consensusCount: 1,
      },
    });

    const wire = await getPublicReportsWire();
    expect(wire.status).toBe("ok");
    const safe: any = (wire as any).reports?.[0];
    expect(safe.reporterPhone).toBeUndefined();
    expect(safe.deviceId).toBeUndefined();
  });

  it("errors honestly when a row fails the clusterable gate", async () => {
    state.fake = makeFakeAdminDb({
      "reports/bad": { lat: "x", lng: 7.6, severity: "high", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1 },
    });
    const wire = await getPublicReportsWire();
    expect(wire.status).toBe("error");
  });
});
