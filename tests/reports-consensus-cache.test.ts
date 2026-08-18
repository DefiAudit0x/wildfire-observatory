import { describe, expect, it, vi } from "vitest";

type StoredReport = {
  id: string;
  timestamp: string;
  consensusCount: number;
  status: string;
  voters?: string[];
};

const state = vi.hoisted(() => ({ reports: new Map<string, StoredReport>(), failTransaction: false }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => createAdminDb(),
  isAdminDb: () => true,
}));

function createAdminDb() {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          return { id, path: `${name}/${id}` };
        },
        orderBy() {
          return {
            limit() {
              return {
                get: async () => ({
                   empty: state.reports.size === 0,
                   docs: [...state.reports.values()].map((report) => ({ id: report.id, data: () => report })),
                }),
              };
            },
          };
        },
      };
    },
    async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
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
  };
}

const { confirmReportInFirestore, getReportsDbResult, invalidateReportsCache } = await import("../server/db.js");

describe("confirmation cache consistency", () => {
  it("invalidates a cached reports read only after a successful confirmation transaction", async () => {
    state.reports.clear();
    invalidateReportsCache();
    state.reports.set("rep-cache-consensus", {
      id: "rep-cache-consensus",
      timestamp: "2026-08-17T00:00:00.000Z",
      consensusCount: 1,
      status: "pending",
    });

    const before = await getReportsDbResult();
    expect(before).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });

    await expect(confirmReportInFirestore("rep-cache-consensus", "voter-cache-test"))
      .resolves.toMatchObject({ status: "confirmed", consensusCount: 2, statusValue: "pending" });

    const after = await getReportsDbResult();
    expect(after).toMatchObject({ status: "ok", reports: [{ consensusCount: 2 }] });
  });

  it("classifies a missing Firestore report without using a RAM fallback", async () => {
    state.reports.clear();
    await expect(confirmReportInFirestore("missing-report", "voter-missing"))
      .resolves.toEqual({ status: "not_found" });
  });

  it("does not invalidate the cache after a failed transaction", async () => {
    state.reports.clear();
    invalidateReportsCache();
    state.reports.set("rep-cache-failure", {
      id: "rep-cache-failure",
      timestamp: "2026-08-17T00:00:00.000Z",
      consensusCount: 1,
      status: "pending",
    });
    const before = await getReportsDbResult();
    expect(before).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });

    state.failTransaction = true;
    await expect(confirmReportInFirestore("rep-cache-failure", "voter-failure"))
      .resolves.toEqual({ status: "error" });
    expect(await getReportsDbResult()).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });
  });
});
