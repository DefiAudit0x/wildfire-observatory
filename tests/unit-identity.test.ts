import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: true, staff: [] as string[], unit: true, deletes: vi.fn() }));
type Ref = { id?: string; identity?: string };
const backend = vi.hoisted(() => ({
  collection: () => ({
    doc: (id: string) => ({ id }),
    where: (_field: string, _op: string, identity: string) => ({ limit: () => ({ identity }) }),
  }),
  runTransaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
    get: async (ref: Ref) => ref.identity !== undefined
      ? { empty: !state.staff.includes(ref.identity) }
      : { exists: state.admin ? state.unit : () => state.unit },
    delete: (ref: Ref) => state.deletes(ref.id),
  }),
}));
vi.mock("../server/firebase.js", () => ({ getDb: () => backend, isAdminDb: () => state.admin }));
vi.mock("firebase/firestore", () => ({
  collection: () => ({}), doc: (_db: unknown, _collection: string, id: string) => ({ id }),
  where: (_field: string, _op: string, identity: string) => ({ identity }), limit: () => ({}),
  query: (_collection: unknown, filter: Ref) => filter,
  runTransaction: (_db: unknown, callback: (tx: unknown) => Promise<unknown>) => backend.runTransaction(callback),
}));
import { deleteUnitIfUnlinked } from "../server/atomic.js";
beforeEach(() => { state.unit = true; state.staff = []; state.deletes.mockClear(); });
describe.each([true, false])("ATM-1 admin SDK=%s", (admin) => {
  it.each(["DZ16", "unit-dz16"])("protects staff linked as %s", async (identity) => {
    state.admin = admin;
    // Route-produced unit document units/unit-dz16 and users with raw DZ16.
    state.staff = [identity];
    expect(await deleteUnitIfUnlinked("unit-dz16")).toBe("has-users");
    expect(state.deletes).not.toHaveBeenCalled();
  });
  it("still deletes an unlinked unit", async () => {
    state.admin = admin;
    expect(await deleteUnitIfUnlinked("unit-dz16")).toBe("deleted");
    expect(state.deletes).toHaveBeenCalledExactlyOnceWith("unit-dz16");
  });
});
