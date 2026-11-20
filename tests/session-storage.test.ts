import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("../server/firebase.js", () => ({
  isAdminDb: () => true,
  getDb: () => ({ collection: () => ({ doc: (id: string) => ({ get: async () => ({ exists: true, id, data: () => state.data }) }) }) }),
}));
import { docGet } from "../server/fs.js";

describe("SAUTH-1/MWARE-1 fresh security reads", () => {
  it.each(["users", "adminRevocations"])("bypasses cached %s state changed by another process", async (collection) => {
    const id = `fresh-${collection}`;
    state.data = { sessionVersion: "old", exp: 0 };
    await docGet(collection, id);
    state.data = { sessionVersion: "new", exp: Date.now() + 3600000 };
    expect(await docGet(collection, id)).toMatchObject({ sessionVersion: "old" });
    expect(await docGet(collection, id, true)).toMatchObject({ sessionVersion: "new" });
  });
});
