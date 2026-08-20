import { describe, expect, it, vi } from "vitest";

type StoredReport = {
  id: string;
  timestamp: string;
  consensusCount: number;
  status: string;
  voters?: string[];
};

const state = vi.hoisted(() => ({ reports: new Map<string, StoredReport>(), failTransaction: false }));
const clientDb = vi.hoisted(() => ({ kind: "client" }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => clientDb,
  isAdminDb: () => false,
}));

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, collection: string, id: string) => ({ collection, id }),
  collection: (_db: unknown, name: string) => ({ name }),
  query: (collection: { name: string }) => ({ collection }),
  orderBy: () => ({}),
  limit: () => ({}),
  getDocs: async () => ({
    empty: state.reports.size === 0,
    docs: [...state.reports.values()].map((report) => ({ id: report.id, data: () => report })),
  }),
  runTransaction: async <T>(_db: unknown, callback: (tx: any) => Promise<T>): Promise<T> => {
    if (state.failTransaction) {
      state.failTransaction = false;
      throw new Error("simulated transaction failure");
    }
    const writes: Array<{ id: string; update: Partial<StoredReport> }> = [];
    const tx = {
      get: async (ref: { id: string }) => {
        const report = state.reports.get(ref.id);
        return { exists: Boolean(report), data: () => report };
      },
      update: (ref: { id: string }, update: Partial<StoredReport>) => writes.push({ id: ref.id, update }),
    };
    const result = await callback(tx);
    for (const write of writes) {
      const existing = state.reports.get(write.id);
      if (existing) state.reports.set(write.id, { ...existing, ...write.update });
    }
    return result;
  },
}));

const { confirmReportInFirestore, getReportsDbResult, invalidateReportsCache } = await import("../server/db.js");

describe("client confirmation cache consistency", () => {
  it("invalidates a cached reports read after a successful client transaction", async () => {
    state.reports.clear();
    invalidateReportsCache();
    state.reports.set("rep-client-cache", {
      id: "rep-client-cache",
      timestamp: "2026-08-20T00:00:00.000Z",
      consensusCount: 1,
      status: "pending",
    });

    const before = await getReportsDbResult();
    expect(before).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });

    await expect(confirmReportInFirestore("rep-client-cache", "client-voter"))
      .resolves.toMatchObject({ status: "confirmed", consensusCount: 2, statusValue: "pending" });

    const after = await getReportsDbResult();
    expect(after).toMatchObject({ status: "ok", reports: [{ consensusCount: 2 }] });
  });

  it("does not invalidate the cache after a failed client transaction", async () => {
    state.reports.clear();
    invalidateReportsCache();
    state.reports.set("rep-client-failure", {
      id: "rep-client-failure",
      timestamp: "2026-08-20T00:00:00.000Z",
      consensusCount: 1,
      status: "pending",
    });

    const before = await getReportsDbResult();
    expect(before).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });

    state.failTransaction = true;
    await expect(confirmReportInFirestore("rep-client-failure", "client-voter-failure"))
      .resolves.toEqual({ status: "error" });
    expect(await getReportsDbResult()).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });
  });
});
