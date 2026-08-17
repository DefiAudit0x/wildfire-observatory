import { describe, expect, it, vi } from "vitest";

type StoredReport = {
  id: string;
  timestamp: string;
  consensusCount: number;
  status: string;
  voters?: string[];
};

const reports = vi.hoisted(() => new Map<string, StoredReport>());

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
                  empty: reports.size === 0,
                  docs: [...reports.values()].map((report) => ({ id: report.id, data: () => report })),
                }),
              };
            },
          };
        },
      };
    },
    async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const writes: Array<{ id: string; update: Partial<StoredReport> }> = [];
      const tx = {
        get: async (ref: { id: string }) => {
          const report = reports.get(ref.id);
          return { exists: Boolean(report), data: () => report };
        },
        update: (ref: { id: string }, update: Partial<StoredReport>) => writes.push({ id: ref.id, update }),
      };
      const result = await callback(tx);
      for (const write of writes) {
        const existing = reports.get(write.id);
        if (existing) reports.set(write.id, { ...existing, ...write.update });
      }
      return result;
    },
  };
}

const { confirmReportInFirestore, getReportsDbResult, invalidateReportsCache } = await import("../server/db.js");

describe("confirmation cache consistency", () => {
  it("invalidates a cached reports read only after a successful confirmation transaction", async () => {
    reports.clear();
    invalidateReportsCache();
    reports.set("rep-cache-consensus", {
      id: "rep-cache-consensus",
      timestamp: "2026-08-17T00:00:00.000Z",
      consensusCount: 1,
      status: "pending",
    });

    const before = await getReportsDbResult();
    expect(before).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });

    await expect(confirmReportInFirestore("rep-cache-consensus", "voter-cache-test"))
      .resolves.toMatchObject({ consensusCount: 2, status: "pending" });

    const after = await getReportsDbResult();
    expect(after).toMatchObject({ status: "ok", reports: [{ consensusCount: 2 }] });
  });
});
