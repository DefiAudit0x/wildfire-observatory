import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused coverage for the collectionGet where filter (CodeRabbit on
// PR #213): the SOS list reads status slices without pulling the whole
// collection, on BOTH Firestore SDK paths. The fake backend applies the
// recorded constraints for real — a where that is ignored or misbuilt
// would return the wrong rows here, not just the wrong call args.
type Row = Record<string, unknown>;
type Constraint =
  | { type: "where"; field: string; op: string; value: unknown }
  | { type: "orderBy"; field: string; dir: string }
  | { type: "limit"; n: number };

const backend = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const state = { admin: true };
  const makeQuery = (name: string, constraints: Constraint[] = []): any => ({
    add: (c: Constraint) => makeQuery(name, [...constraints, c]),
    where: (field: string, op: string, value: unknown) =>
      makeQuery(name, [...constraints, { type: "where", field, op, value }]),
    orderBy: (field: string, dir: string) =>
      makeQuery(name, [...constraints, { type: "orderBy", field, dir }]),
    limit: (n: number) => makeQuery(name, [...constraints, { type: "limit", n }]),
    get: async () => {
      let docs = [...rows.entries()]
        .filter(([k]) => k.startsWith(`${name}/`))
        .map(([k, data]) => ({ id: k.slice(name.length + 1), data: () => structuredClone(data) }));
      for (const c of constraints) {
        if (c.type === "where") {
          docs = docs.filter((d) => {
            const v = d.data()[c.field];
            // Firestore converts `== NaN` to IS_NAN, so a NaN query matches
            // NaN fields (CodeRabbit on PR #213) — strict `===` alone
            // never matches NaN, which made the seeded NaN row invisible.
            if (c.op === "==") return v === c.value || (Number.isNaN(v) && Number.isNaN(c.value));
            if (c.op === "!=") return v !== c.value;
            return true;
          });
        } else if (c.type === "orderBy") {
          docs = [...docs].sort((a, b) => {
            const av = String(a.data()[c.field]);
            const bv = String(b.data()[c.field]);
            return c.dir === "desc" ? (av < bv ? 1 : av > bv ? -1 : 0) : av < bv ? -1 : av > bv ? 1 : 0;
          });
        } else if (c.type === "limit") {
          docs = docs.slice(0, c.n);
        }
      }
      return { empty: docs.length === 0, docs };
    },
  });
  return {
    rows,
    state,
    makeQuery,
    db: { collection: (name: string) => makeQuery(name) },
  };
});

vi.mock("../server/firebase.js", () => ({
  getDb: () => backend.db,
  isAdminDb: () => backend.state.admin,
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { increment: (n: number) => ({ increment: n }) } }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, name: string) => backend.makeQuery(name),
  getDocs: (q: any) => q.get(),
  query: (ref: any, ...constraints: any[]) => constraints.reduce((q: any, c: any) => q.add(c), ref),
  orderBy: (field: string, dir: string) => ({ type: "orderBy", field, dir }),
  limit: (n: number) => ({ type: "limit", n }),
  where: (field: string, op: string, value: unknown) => ({ type: "where", field, op, value }),
}));

for (const admin of [true, false]) {
  describe(`${admin ? "admin" : "client"} SDK collectionGet where filter`, () => {
    let fs: typeof import("../server/fs.js");

    beforeEach(async () => {
      vi.resetModules();
      backend.rows.clear();
      backend.state.admin = admin;
      fs = await import("../server/fs.js");
      for (let i = 0; i < 3; i++) {
        backend.rows.set(`trappedSos/active-${i}`, {
          status: "active",
          timestamp: new Date(Date.now() - i * 60_000).toISOString(),
        });
      }
      for (let i = 0; i < 150; i++) {
        backend.rows.set(`trappedSos/resolved-${String(i).padStart(3, "0")}`, {
          status: "resolved",
          timestamp: new Date(Date.now() - (i + 10) * 60_000).toISOString(),
        });
      }
    });

    it("returns only the matching slice, newest first", async () => {
      const active = await fs.collectionGet("trappedSos", "timestamp", undefined, false, {
        field: "status",
        op: "==",
        value: "active",
      });
      expect(active!.map((r: any) => r.id)).toEqual(["active-0", "active-1", "active-2"]);
    });

    it("caps the resolved slice at the requested limit", async () => {
      const resolved = await fs.collectionGet("trappedSos", "timestamp", 100, false, {
        field: "status",
        op: "==",
        value: "resolved",
      });
      expect(resolved).toHaveLength(100);
      expect(resolved![0].id).toBe("resolved-000");
      expect(resolved![99].id).toBe("resolved-099");
      expect(resolved!.some((r: any) => r.id === "resolved-149")).toBe(false);
    });

    it("keeps where-filtered and unfiltered reads on separate cache keys", async () => {
      const active = await fs.collectionGet("trappedSos", "timestamp", undefined, false, {
        field: "status",
        op: "==",
        value: "active",
      });
      expect(active).toHaveLength(3);
      // The unfiltered read must not serve the cached active slice.
      const all = await fs.collectionGet("trappedSos", "timestamp");
      expect(all).toHaveLength(153);
      // And the filtered read afterwards still serves its own slice.
      const again = await fs.collectionGet("trappedSos", "timestamp", undefined, false, {
        field: "status",
        op: "==",
        value: "active",
      });
      expect(again).toHaveLength(3);
    });

    it("gives null, NaN, ±Infinity, -0, undefined and the string \"null\" distinct cache keys", () => {
      // CodeRabbit on PR #213: JSON.stringify collapses null, NaN and
      // Infinity all to "null", so those filters shared one cache key.
      const values: unknown[] = [null, NaN, Infinity, -Infinity, -0, undefined, "null", 0, "active", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z")];
      const keys = values.map((v) =>
        fs.collectionCacheKey("trappedSos", "timestamp", undefined, { field: "status", op: "==", value: v })
      );
      expect(new Set(keys).size).toBe(values.length);
    });

    it("gives colliding (field, op) pairs distinct cache keys", () => {
      // CodeRabbit on PR #213: the where segment concatenated field + op
      // with no separator, so field "statusnot-" + op "in" collided with
      // field "status" + op "not-in" ("statusnot-in" either way).
      const keys = [
        fs.collectionCacheKey("trappedSos", "timestamp", undefined, { field: "statusnot-", op: "in", value: ["active"] }),
        fs.collectionCacheKey("trappedSos", "timestamp", undefined, { field: "status", op: "not-in", value: ["active"] }),
        fs.collectionCacheKey("trappedSos", "timestamp", undefined, { field: "status", op: "in", value: ["active"] }),
        fs.collectionCacheKey("trappedSos", "timestamp", undefined, { field: "status", op: "==", value: "active" }),
        fs.collectionCacheKey("trappedSos", "timestamp", undefined, { field: "status", op: "!=", value: "active" }),
      ];
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("does not serve one filter value's cached rows to a distinct filter value", async () => {
      // End-to-end through collectionGet: the null query caches its rows;
      // a NaN query (or the string "null") must not be served them.
      const now = Date.now();
      backend.rows.set("trappedSos/score-null", { status: "active", score: null, timestamp: new Date(now).toISOString() });
      backend.rows.set("trappedSos/score-nan", { status: "active", score: NaN, timestamp: new Date(now - 60_000).toISOString() });
      backend.rows.set("trappedSos/score-inf", { status: "active", score: Infinity, timestamp: new Date(now - 120_000).toISOString() });
      const nullRows = await fs.collectionGet("trappedSos", undefined, undefined, false, {
        field: "score", op: "==", value: null,
      });
      expect(nullRows!.map((r: any) => r.id)).toEqual(["score-null"]);
      const nanRows = await fs.collectionGet("trappedSos", undefined, undefined, false, {
        field: "score", op: "==", value: NaN,
      });
      // Firestore `== NaN` is IS_NAN: it matches the seeded NaN row.
      expect(nanRows!.map((r: any) => r.id)).toEqual(["score-nan"]);
      const infRows = await fs.collectionGet("trappedSos", undefined, undefined, false, {
        field: "score", op: "==", value: Infinity,
      });
      expect(infRows!.map((r: any) => r.id)).toEqual(["score-inf"]);
      const strRows = await fs.collectionGet("trappedSos", undefined, undefined, false, {
        field: "score", op: "==", value: "null",
      });
      expect(strRows).toHaveLength(0);
    });
  });
}
