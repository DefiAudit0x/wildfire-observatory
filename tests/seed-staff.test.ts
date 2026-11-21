import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  store: new Map<string, Record<string, unknown>>(),
  target: "users",
  mode: "read-failure",
  original: { passwordHash: "existing-hash", role: "commander", isActive: false, createdAt: "original" },
  writes: vi.fn(),
  reads: vi.fn(),
}));
function ref(collection: string, id: string) { return { key: `${collection}/${id}`, collection }; }
vi.mock("../server/firebase.js", () => ({
  isAdminDb: () => true,
  getDb: () => ({
    collection: (collection: string) => ({ doc: (id: string) => ref(collection, id) }),
    runTransaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      get: async (reference: ReturnType<typeof ref>) => {
        state.reads(reference.key);
        if (reference.collection === state.target) {
          if (state.mode === "read-failure") throw new Error("read failed");
          if (state.mode === "concurrent") state.store.set(reference.key, { ...state.original });
        }
        const data = state.store.get(reference.key);
        return { exists: !!data, data: () => data };
      },
      create: (reference: ReturnType<typeof ref>, data: Record<string, unknown>) => {
        if (reference.collection === state.target && state.mode === "write-failure") throw new Error("write failed");
        if (state.store.has(reference.key)) throw new Error("already exists");
        state.writes(reference.key); state.store.set(reference.key, data);
      },
    }),
  }),
}));
// Model docGet's lossy null on failure, or a stale absence before a competing
// creator. These are the old seeder's dependencies; the fixed seeder uses the
// real createDocIfAbsent helper and the transaction mock above instead.
vi.mock("../server/fs.js", () => ({
  docGet: async (collection: string, id: string) => {
    const key = `${collection}/${id}`;
    if (collection === state.target) {
      if (state.mode === "concurrent") state.store.set(key, { ...state.original });
      return null;
    }
    return state.store.get(key) || null;
  },
  docSet: async (collection: string, id: string, data: Record<string, unknown>) => {
    const key = `${collection}/${id}`; state.writes(key); state.store.set(key, data); return true;
  },
}));
vi.mock("bcryptjs", () => ({ default: { hash: async () => "new-password-hash" } }));
beforeEach(() => {
  vi.resetModules(); state.store.clear(); state.writes.mockClear(); state.reads.mockClear();
  vi.stubEnv("SEED_AGENT_PASSWORD", "StrongPassword123");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("SEED-2 never replaces existing records", () => {
  it.each([
    ["users", "cmd-dz16", "read-failure"], ["units", "unit-dz16", "read-failure"],
    ["users", "cmd-dz16", "concurrent"], ["units", "unit-dz16", "concurrent"],
  ])("preserves %s on %s (%s)", async (collection, id, mode) => {
    state.target = collection; state.mode = mode;
    const key = `${collection}/${id}`;
    if (mode === "read-failure") state.store.set(key, { ...state.original });
    await import("../scripts/seed-staff.js");
    await vi.waitFor(() => {
      expect(vi.mocked(process.exit).mock.calls.length || vi.mocked(console.log).mock.calls.some(([message]) => String(message).includes("Seed finished"))).toBeTruthy();
    });
    expect(state.store.get(key)).toEqual(state.original);
    expect(state.writes).not.toHaveBeenCalledWith(key);
    if (mode === "read-failure") expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe("SEED-1 persistence failures", () => {
  it.each([["units", "read-failure"], ["users", "read-failure"], ["units", "write-failure"], ["users", "write-failure"]])("exits unsuccessfully when %s persistence has %s", async (collection, mode) => {
    state.target = collection; state.mode = mode;
    await import("../scripts/seed-staff.js");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(console.error).toHaveBeenCalled();
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain(collection === "units" ? "Unit created:" : "User created:");
    expect(output).not.toContain("Seed finished.");
    expect(output).not.toContain("Login via");
  });
  it("succeeds when both records already exist", async () => {
    state.target = "none"; state.mode = "concurrent";
    state.store.set("units/unit-dz16", { code: "DZ16" });
    state.store.set("users/cmd-dz16", { ...state.original });
    await import("../scripts/seed-staff.js");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Seed finished.")));
    expect(process.exit).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });
});
