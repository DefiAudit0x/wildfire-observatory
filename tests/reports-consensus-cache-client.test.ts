import { describe, expect, it, vi } from "vitest";

type StoredReport = {
  id: string;
  timestamp: string;
  consensusCount: number;
  status: string;
  communityConfirmed?: boolean;
  voters?: string[];
};

const state = vi.hoisted(() => ({ reports: new Map<string, StoredReport>(), confirmations: new Set<string>(), failTransaction: false }));
const clientDb = vi.hoisted(() => ({ kind: "client" }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => clientDb,
  isAdminDb: () => false,
}));

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, collection: string, id: string) => ({
    id,
    // Ledger subcollection surface: reports/{id}/confirmations/{subject}
    collection(sub: string) {
      return {
        doc(subId: string) {
          return { id: subId, path: `${collection}/${id}/${sub}/${subId}` };
        },
      };
    },
    path: `${collection}/${id}`,
  }),
  collection: (_db: unknown, name: string) => ({ name }),
  query: (collection: { name: string }) => ({ collection }),
  orderBy: () => ({}),
  limit: () => ({}),
  // ARC-L07: production reads are cursor-paginated, so the SDK surface now
  // includes startAfter; the mock models it (never called for short pages).
  startAfter: () => ({}),
  getDocs: async () => ({
    empty: state.reports.size === 0,
    docs: [...state.reports.values()].map((report) => ({ id: report.id, data: () => report })),
  }),
  runTransaction: async <T>(_db: unknown, callback: (tx: any) => Promise<T>): Promise<T> => {
    if (state.failTransaction) {
      state.failTransaction = false;
      throw new Error("simulated transaction failure");
    }
    const writes: Array<{ key: string; update: Partial<StoredReport> }> = [];
    const creates: string[] = [];
    const tx = {
      get: async (ref: { id: string; path?: string }) => {
        if (ref.path && ref.path.includes("confirmations")) {
          return { exists: () => state.confirmations.has(ref.path!), data: () => (state.confirmations.has(ref.path!) ? { subject: ref.id } : undefined) };
        }
        const report = state.reports.get(ref.id);
        return { exists: () => Boolean(report), data: () => report };
      },
      update: (ref: { path?: string; id: string }, update: Partial<StoredReport>) => writes.push({ key: ref.path ?? ref.id, update }),
      create: (ref: { path: string }, _data: unknown) => creates.push(ref.path),
    };
    const result = await callback(tx);
    for (const write of writes) {
      if (write.key.includes("confirmations")) continue;
      const existing = state.reports.get(write.key);
      if (existing) state.reports.set(write.key, { ...existing, ...write.update });
    }
    for (const path of creates) state.confirmations.add(path);
    return result;
  },
}));

// v2.15.0: the ledger is the only live confirmation contract; the legacy
// optional-voterId db.confirm API was dead code and was deleted.
const { getReportsDbResult, invalidateReportsCache } = await import("../server/db.js");
const { confirmReportWithPrincipal } = await import("../server/confirmation-ledger.js");

describe("v2.15.0 — ledger requires the admin SDK (client-kind db is honestly no_db)", () => {
  it("returns no_db for a client-kind Firestore handle — no phantom confirm path", async () => {
    // The legacy confirmReportInFirestore had a client-SDK branch that no
    // route ever reached. The ledger is admin-SDK only: a client-kind handle
    // is an honest no_db, not a second confirmation contract.
    state.reports.clear();
    state.confirmations.clear();
    invalidateReportsCache();
    state.reports.set("rep-client-cache", {
      id: "rep-client-cache",
      timestamp: "2026-08-20T00:00:00.000Z",
      consensusCount: 1,
      status: "pending",
    });

    await expect(confirmReportWithPrincipal("rep-client-cache", "client-voter"))
      .resolves.toEqual({ status: "no_db" });
    // Nothing was written behind the caller's back.
    expect(state.reports.get("rep-client-cache")).toMatchObject({ consensusCount: 1, status: "pending" });
  });
});
