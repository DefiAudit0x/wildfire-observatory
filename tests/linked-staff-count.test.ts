import { beforeEach, describe, expect, it, vi } from "vitest";

type Document = Record<string, unknown>;
type Ref = { path: string; id: string };
type Write = { kind: "create" | "set" | "update" | "delete"; path: string; data?: Document };

const state = vi.hoisted(() => ({
  admin: true,
  docs: new Map<string, Document>(),
  updates: [] as Array<{ path: string; data: Document }>,
  deletes: [] as string[],
}));

function ref(collection: string, id: string): Ref {
  return { path: `${collection}/${id}`, id };
}

function snapshot(path: string, admin: boolean) {
  const data = state.docs.get(path);
  return admin
    ? { exists: Boolean(data), id: path.split("/").at(-1), data: () => data }
    : { exists: () => Boolean(data), id: path.split("/").at(-1), data: () => data };
}

function increment(amount: number) {
  return { __increment: amount };
}

function apply(write: Write) {
  if (write.kind === "delete") {
    state.docs.delete(write.path);
    state.deletes.push(write.path);
    return;
  }
  if (write.kind === "create" || write.kind === "set") {
    state.docs.set(write.path, { ...(write.data || {}) });
    return;
  }
  const current = { ...(state.docs.get(write.path) || {}) };
  for (const [key, value] of Object.entries(write.data || {})) {
    current[key] = value && typeof value === "object" && "__increment" in value
      ? Number(current[key] || 0) + Number((value as { __increment: number }).__increment)
      : value;
  }
  state.docs.set(write.path, current);
  state.updates.push({ path: write.path, data: write.data || {} });
}

function transaction(callback: (tx: any) => Promise<unknown>) {
  const writes: Write[] = [];
  const tx = {
    get: async (target: Ref | { identity?: string }) => {
      if (!("path" in target)) {
        const found = [...state.docs.entries()].some(([path, data]) =>
          path.startsWith("users/") && data.unitId === target.identity
        );
        return { empty: !found };
      }
      return snapshot(target.path, state.admin);
    },
    create: (target: Ref, data: Document) => writes.push({ kind: "create", path: target.path, data }),
    set: (target: Ref, data: Document) => writes.push({ kind: "set", path: target.path, data }),
    update: (target: Ref, data: Document) => writes.push({ kind: "update", path: target.path, data }),
    delete: (target: Ref) => writes.push({ kind: "delete", path: target.path }),
  };
  return callback(tx).then((result) => {
    writes.forEach(apply);
    return result;
  });
}

const adminDb = {
  collection: (name: string) => ({
    doc: (id: string) => ref(name, id),
    where: (_field: string, _op: string, identity: string) => ({
      identity,
      limit: (_count: number) => ({ identity }),
    }),
  }),
  runTransaction: transaction,
};

vi.mock("../server/firebase.js", () => ({ getDb: () => adminDb, isAdminDb: () => state.admin }));
vi.mock("../server/logger.js", () => ({ default: { error: vi.fn() } }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { increment } }));
vi.mock("firebase/firestore", () => ({
  collection: () => ({}),
  doc: (_db: unknown, name: string, id: string) => ref(name, id),
  getDocs: async (query: { identity?: string }) => ({
    empty: ![...state.docs.entries()].some(([path, data]) => path.startsWith("users/") && data.unitId === query.identity),
  }),
  increment,
  limit: (_count: number) => ({}),
  query: (_collection: unknown, filter: { identity?: string }) => filter,
  runTransaction: (_db: unknown, callback: (tx: any) => Promise<unknown>) => transaction(callback),
  where: (_field: string, _op: string, identity: string) => ({ identity }),
}));

const { createUserIfUnitExists, deleteUnitIfUnlinked, deleteUserAtomically } = await import("../server/atomic.js");
const { updateUserAtomic } = await import("../server/fs.js");

beforeEach(() => {
  state.docs.clear();
  state.updates.length = 0;
  state.deletes.length = 0;
  state.admin = true;
});

describe.each([true, false])( "linkedStaffCount SDK admin=%s", (admin) => {
  beforeEach(() => { state.admin = admin; });

  it("blocks unit deletion from the transaction marker when no staff query finds a user", async () => {
    state.docs.set("units/unit-dz16", { linkedStaffCount: 2 });

    expect(await deleteUnitIfUnlinked("unit-dz16")).toBe("has-users");
    expect(state.deletes).not.toContain("units/unit-dz16");
  });

  it("increments the unit marker in the same transaction as staff creation", async () => {
    state.docs.set("units/unit-dz16", { code: "DZ16" });

    expect(await createUserIfUnitExists("agent-1", "unit-dz16", { agentId: "agent-1", unitId: "DZ16" })).toBe("created");
    expect(state.docs.get("units/unit-dz16")?.linkedStaffCount).toBe(1);
    expect(state.docs.get("users/agent-1")?.linkedStaffCounted).toBe(true);
    expect(state.updates).toContainEqual({ path: "units/unit-dz16", data: { linkedStaffCount: increment(1) } });
  });

  it.each([
    ["DZ16", "DZ17"],
    ["DZ16", "unit-dz17"],
    ["unit-dz16", "DZ17"],
    ["unit-dz16", "unit-dz17"],
  ])("transfers the marker from %s to %s", async (oldUnitId, newUnitId) => {
    state.docs.set("units/unit-dz16", { linkedStaffCount: 1 });
    state.docs.set("units/unit-dz17", { linkedStaffCount: 0 });
    state.docs.set("users/agent-1", { agentId: "agent-1", unitId: oldUnitId, linkedStaffCounted: true });

    const result = await updateUserAtomic("agent-1", { unitId: newUnitId }, () => null);

    expect(result.outcome).toBe("updated");
    expect(state.docs.get("units/unit-dz16")?.linkedStaffCount).toBe(0);
    expect(state.docs.get("units/unit-dz17")?.linkedStaffCount).toBe(1);
    expect(state.updates.map((write) => write.path)).toEqual(["units/unit-dz16", "units/unit-dz17", "users/agent-1"]);
  });

  it("decrements the unit marker when deleting a counted staff user", async () => {
    state.docs.set("units/unit-dz16", { linkedStaffCount: 1 });
    state.docs.set("users/agent-1", { agentId: "agent-1", unitId: "DZ16", linkedStaffCounted: true });

    expect(await deleteUserAtomically("agent-1")).toBe("deleted");
    expect(state.docs.has("users/agent-1")).toBe(false);
    expect(state.docs.get("units/unit-dz16")?.linkedStaffCount).toBe(0);
    expect(state.updates).toContainEqual({ path: "units/unit-dz16", data: { linkedStaffCount: increment(-1) } });
  });

  it("does not decrement for a missing user or an uncounted user without a unit", async () => {
    expect(await deleteUserAtomically("missing")).toBe("not-found");
    state.docs.set("users/agent-2", { agentId: "agent-2", linkedStaffCounted: true });
    expect(await deleteUserAtomically("agent-2")).toBe("deleted");
    expect(state.updates).toHaveLength(0);
  });

  it("keeps legacy staff uncounted until a move adds them to the marker", async () => {
    state.docs.set("units/unit-dz16", { linkedStaffCount: 0 });
    state.docs.set("units/unit-dz17", { linkedStaffCount: 0 });
    state.docs.set("users/legacy", { agentId: "legacy", unitId: "DZ16" });

    const result = await updateUserAtomic("legacy", { unitId: "DZ17" }, () => null);

    expect(result.outcome).toBe("updated");
    expect(state.docs.get("units/unit-dz16")?.linkedStaffCount).toBe(0);
    expect(state.docs.get("units/unit-dz17")?.linkedStaffCount).toBe(1);
    expect(state.docs.get("users/legacy")?.linkedStaffCounted).toBe(true);
  });
});
