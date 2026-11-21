import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Ref = { path: string; set: (row: Row) => Promise<void> };
type Transaction = {
  get: (ref: Ref) => Promise<{ exists: boolean; data: () => Row | undefined }>;
  set: (ref: Ref, row: Row) => void;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  writes: [] as string[],
  afterSnapshot: () => {},
  failCommit: false,
}));
const path = "reports/legacy";
const legacy = {
  status: "pending", severity: "high", timestamp: "2026-11-21T00:00:00Z",
  reporterName: "Reporter", deviceId: "device", image: "data:image/png;base64,AAAA",
};
const ref = (key: string): Ref => ({
  path: key,
  set: async (row) => { state.writes.push(key); state.rows.set(key, row); },
});
const db = {
  collection: (collection: string) => ({
    doc: (id: string) => ref(`${collection}/${id}`),
    orderBy: () => ({ limit: () => ({ get: async () => {
      const snapshot = [...state.rows.entries()]
        .filter(([key]) => key.startsWith(`${collection}/`))
        .map(([key, row]) => ({ id: key.split("/")[1], data: () => structuredClone(row) }));
      const hook = state.afterSnapshot;
      state.afterSnapshot = () => {};
      hook();
      return { docs: snapshot, empty: snapshot.length === 0 };
    } }) }),
  }),
  runTransaction: async (callback: (tx: Transaction) => Promise<boolean>) => {
    const staged: Array<[Ref, Row]> = [];
    const result = await callback({
      get: async (target) => {
        const row = state.rows.get(target.path);
        return { exists: row !== undefined, data: () => row && structuredClone(row) };
      },
      set: (target, row) => { staged.push([target, row]); },
    });
    if (state.failCommit) throw new Error("commit unavailable");
    for (const [target, row] of staged) await target.set(row);
    return result;
  },
};
vi.mock("../server/firebase.js", () => ({ getDb: () => db, isAdminDb: () => true }));
import { getReportsDbResult, invalidateReportsCache } from "../server/db.js";

// Wait for the actual fire-and-forget migration, including its catch handler.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  invalidateReportsCache();
  state.rows.clear();
  state.rows.set(path, structuredClone(legacy));
  state.writes.length = 0;
  state.afterSnapshot = () => {};
  state.failCommit = false;
});

describe("DB-1: legacy migration is conditional and atomic", () => {
  it.each(["deleted", "verified", "resolved", "severity", "identity"])(
    "does not write any shard after the snapshot becomes %s; a fresh read can retry",
    async (change) => {
      state.afterSnapshot = () => {
        if (change === "deleted") state.rows.delete(path);
        else state.rows.set(path, {
          ...legacy,
          ...(change === "severity" ? { severity: "critical" }
            : change === "identity" ? { reporterName: "Corrected" } : { status: change }),
        });
      };
      const result = await getReportsDbResult();
      expect(result.status).toBe("ok");
      await settle();
      expect(state.writes).toEqual([]);
      expect(state.rows.has("reportPrivate/legacy")).toBe(false);
      expect(state.rows.has("reportImages/legacy")).toBe(false);
      if (change === "deleted") {
        expect(state.rows.has(path)).toBe(false);
        return;
      }
      const moderated = structuredClone(state.rows.get(path));
      invalidateReportsCache();
      await getReportsDbResult();
      await settle();
      expect(state.rows.get(path)).toEqual({
        status: moderated?.status, severity: moderated?.severity,
        timestamp: legacy.timestamp, id: "legacy", hasImage: true,
      });
      expect(state.rows.get("reportPrivate/legacy")).toMatchObject({
        reporterName: moderated?.reporterName, deviceId: "device", reportId: "legacy",
      });
      expect(state.rows.get("reportImages/legacy")).toMatchObject({ image: legacy.image });
    }
  );

  it("writes no partial shards on transaction failure and migrates the untouched row on retry", async () => {
    state.failCommit = true;
    await getReportsDbResult();
    await settle();
    expect(state.writes).toEqual([]);
    expect(state.rows.get(path)).toEqual(legacy);
    state.failCommit = false;
    invalidateReportsCache();
    await getReportsDbResult();
    await settle();
    expect(state.writes).toEqual(["reportPrivate/legacy", "reportImages/legacy", path]);
    expect(state.rows.get(path)).toEqual({
      id: "legacy", status: "pending", severity: "high", timestamp: legacy.timestamp, hasImage: true,
    });
    expect(state.rows.get("reportPrivate/legacy")).toMatchObject({ reporterName: "Reporter" });
    expect(state.rows.get("reportImages/legacy")).toMatchObject({ image: legacy.image });
  });
});
