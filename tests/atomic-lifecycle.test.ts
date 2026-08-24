import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  units: new Set<string>(),
  users: new Set<string>(),
}));

const db = vi.hoisted(() => ({
  collection: (name: string) => ({
    doc: (id: string) => ({ kind: "doc", collection: name, id }),
    where: (_field: string, _op: string, value: string) => ({
      kind: "query",
      collection: name,
      unitId: value,
      limit: (_n: number) => ({ kind: "query", collection: name, unitId: value }),
    }),
  }),
  runTransaction: async (callback: (tx: any) => Promise<any>) => callback({
    get: async (target: any) => {
      if (target.kind === "doc") {
        const exists = target.collection === "units" ? state.units.has(target.id) : state.users.has(target.id);
        return { exists, id: target.id, data: () => ({ unitId: target.id }) };
      }
      const hasUser = [...state.users].some((id) => id === target.unitId);
      return { empty: !hasUser };
    },
    create: (ref: any) => {
      if (ref.collection === "users") state.users.add(ref.id);
      if (ref.collection === "units") state.units.add(ref.id);
    },
    delete: (ref: any) => state.units.delete(ref.id),
  }),
}));

vi.mock("../server/firebase.js", () => ({
  getDb: () => db,
  isAdminDb: () => true,
}));
vi.mock("../server/logger.js", () => ({ default: { error: vi.fn() } }));

const { createUserIfUnitExists, deleteUnitIfUnlinked } = await import("../server/atomic.js");

beforeEach(() => {
  state.units.clear();
  state.users.clear();
});

describe("unit/user lifecycle atomicity", () => {
  it("refuses user creation when the unit does not exist", async () => {
    const result = await createUserIfUnitExists("agent-1", "unit-a", { agentId: "agent-1", unitId: "unit-a" });
    expect(result).toBe("unit-missing");
    expect(state.users.has("agent-1")).toBe(false);
  });

  it("creates a user only while the unit exists", async () => {
    state.units.add("unit-a");
    const result = await createUserIfUnitExists("agent-1", "unit-a", { agentId: "agent-1", unitId: "unit-a" });
    expect(result).toBe("created");
    expect(state.users.has("agent-1")).toBe(true);
  });

  it("refuses unit deletion while a user references it", async () => {
    state.units.add("unit-a");
    state.users.add("agent-1");
    const result = await deleteUnitIfUnlinked("unit-a");
    expect(result).toBe("has-users");
    expect(state.units.has("unit-a")).toBe(true);
  });

  it("deletes an unlinked unit atomically", async () => {
    state.units.add("unit-a");
    const result = await deleteUnitIfUnlinked("unit-a");
    expect(result).toBe("deleted");
    expect(state.units.has("unit-a")).toBe(false);
  });
});
