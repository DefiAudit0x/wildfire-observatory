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

vi.mock("../server/firebase.js", () => ({
  getDb: () => createAdminDb(),
  isAdminDb: () => true,
}));

function createAdminDb() {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            id,
            path: `${name}/${id}`,
            // Ledger subcollection: reports/{id}/confirmations/{subject}
            collection(sub: string) {
              return {
                doc(subId: string) {
                  return { id: subId, path: `${name}/${id}/${sub}/${subId}` };
                },
              };
            },
          };
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
      const writes: Array<{ ref: { id: string; path: string }; update: Partial<StoredReport> }> = [];
      const creates: Array<{ ref: { path: string }; data: unknown }> = [];
      const tx = {
        get: async (ref: { id: string; path: string }) => {
          if (ref.path.includes("confirmations")) {
            return { exists: state.confirmations.has(ref.path), data: () => (state.confirmations.has(ref.path) ? { subject: ref.id } : undefined) };
          }
          const report = state.reports.get(ref.id);
          return { exists: Boolean(report), data: () => report };
        },
        update: (ref: { id: string; path: string }, update: Partial<StoredReport>) => writes.push({ ref, update }),
        create: (ref: { path: string }, data: unknown) => creates.push({ ref, data }),
      };
      const result = await callback(tx);
      for (const write of writes) {
        if (write.ref.path.includes("confirmations")) continue;
        const existing = state.reports.get(write.ref.id);
        if (existing) state.reports.set(write.ref.id, { ...existing, ...write.update });
      }
      for (const created of creates) state.confirmations.add(created.ref.path);
      return result;
    },
  };
}

// v2.15.0: the ledger (confirmReportWithPrincipal) is the ONLY live
// confirmation contract — the legacy optional-voterId confirm API was dead
// code carrying a second stale 5→verified flip path and was deleted.
const { getReportsDbResult, invalidateReportsCache } = await import("../server/db.js");
const { confirmReportWithPrincipal } = await import("../server/confirmation-ledger.js");

describe("confirmation ledger — cache consistency + Sybil-honest status", () => {
  it("invalidates a cached reports read only after a successful confirmation transaction", async () => {
    state.reports.clear();
    state.confirmations.clear();
    invalidateReportsCache();
    state.reports.set("rep-cache-consensus", {
      id: "rep-cache-consensus",
      timestamp: "2026-08-17T00:00:00.000Z",
      consensusCount: 1,
      status: "pending",
    });

    const before = await getReportsDbResult();
    expect(before).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });

    await expect(confirmReportWithPrincipal("rep-cache-consensus", "voter-cache-test"))
      .resolves.toMatchObject({ status: "confirmed", consensusCount: 2, statusValue: "pending" });

    const after = await getReportsDbResult();
    expect(after).toMatchObject({ status: "ok", reports: [{ consensusCount: 2 }] });
  });

  it("classifies a missing Firestore report without using a RAM fallback", async () => {
    state.reports.clear();
    state.confirmations.clear();
    await expect(confirmReportWithPrincipal("missing-report", "voter-missing"))
      .resolves.toEqual({ status: "not_found" });
  });

  it("does not invalidate the cache after a failed transaction", async () => {
    state.reports.clear();
    state.confirmations.clear();
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
    await expect(confirmReportWithPrincipal("rep-cache-failure", "voter-failure"))
      .resolves.toEqual({ status: "error" });
    expect(await getReportsDbResult()).toMatchObject({ status: "ok", reports: [{ consensusCount: 1 }] });
  });

  it("v2.15.0 Sybil fix: 5 anonymous confirmations set communityConfirmed, NEVER flip status to verified", async () => {
    state.reports.clear();
    state.confirmations.clear();
    invalidateReportsCache();
    state.reports.set("rep-sybil", {
      id: "rep-sybil",
      timestamp: "2026-09-04T00:00:00.000Z",
      consensusCount: 0,
      status: "pending",
    });

    // Five fresh anonymous principals from (potentially) one IP used to mint
    // "verified". Now the status is reserved for the trusted paths
    // (badge verification at creation / operator moderation); the community
    // threshold records the distinct communityConfirmed state instead.
    for (let i = 1; i <= 5; i++) {
      const result = await confirmReportWithPrincipal("rep-sybil", `principal-${i}`);
      expect(result).toMatchObject({ status: "confirmed" });
    }
    expect(state.reports.get("rep-sybil")).toMatchObject({
      consensusCount: 5,
      status: "pending",
      communityConfirmed: true,
    });

    // A badge/operator-verified report is untouched by community confirms.
    state.reports.set("rep-official", {
      id: "rep-official",
      timestamp: "2026-09-04T00:00:00.000Z",
      consensusCount: 0,
      status: "verified",
    });
    await expect(confirmReportWithPrincipal("rep-official", "principal-x"))
      .resolves.toMatchObject({ status: "confirmed", statusValue: "verified" });
    expect(state.reports.get("rep-official")).toMatchObject({ status: "verified", consensusCount: 1 });
  });

  it("one-principal-one-vote remains durable across repeated attempts", async () => {
    state.reports.clear();
    state.confirmations.clear();
    state.reports.set("rep-dedupe", {
      id: "rep-dedupe",
      timestamp: "2026-09-04T00:00:00.000Z",
      consensusCount: 0,
      status: "pending",
    });
    await expect(confirmReportWithPrincipal("rep-dedupe", "p-1")).resolves.toMatchObject({ status: "confirmed", consensusCount: 1 });
    await expect(confirmReportWithPrincipal("rep-dedupe", "p-1")).resolves.toEqual({ status: "already_voted" });
    await expect(confirmReportWithPrincipal("rep-dedupe", "p-1")).resolves.toEqual({ status: "already_voted" });
    expect(state.reports.get("rep-dedupe")).toMatchObject({ consensusCount: 1 });
  });
});
