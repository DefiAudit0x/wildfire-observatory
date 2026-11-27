import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admin: true,
  current: {} as Record<string, unknown>,
  version: 0,
  onRead: null as (() => void) | null,
  writes: 0,
}));
type Ref = { id: string };
const backend = vi.hoisted(() => {
  const transaction = async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    for (let retry = 0; retry < 3; retry++) {
      const version = state.version;
      const pending: { value: Record<string, unknown> | null } = { value: null };
      const result = await callback({
        get: async () => {
          const data = structuredClone(state.current);
          const onRead = state.onRead;
          state.onRead = null;
          onRead?.();
          return { exists: state.admin ? true : () => true, data: () => data };
        },
        set: (_ref: Ref, update: Record<string, unknown>) => { pending.value = update; },
      });
      if (state.version !== version) continue;
      if (pending.value) { state.current = { ...state.current, ...pending.value }; state.writes++; }
      return result;
    }
    throw new Error("Retry budget exhausted");
  };
  return { collection: () => ({ doc: (id: string) => ({ id }) }), runTransaction: transaction };
});
vi.mock("../server/firebase.js", () => ({ getDb: () => backend, isAdminDb: () => state.admin }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, _collection: string, id: string) => ({ id }),
  runTransaction: (_db: unknown, callback: (tx: unknown) => Promise<unknown>) => backend.runTransaction(callback),
}));
import { deactivateTeamMemberIfGeneration, removeAgentFromRosterDay } from "../server/atomic.js";

beforeEach(() => { state.current = {}; state.version = 0; state.onRead = null; state.writes = 0; });
describe.each([true, false])("Round 2 guarded writes, admin SDK=%s", (admin) => {
  it("F063: transaction retry refuses the old generation after a rejoin", async () => {
    state.admin = admin;
    state.current = { teamId: "team", active: true, tokenGen: 0 };
    state.onRead = () => { state.current = { teamId: "team", active: true, tokenGen: 1 }; state.version++; };
    expect(await deactivateTeamMemberIfGeneration("member", "team", 0)).toBe("revoked");
    expect(state.current.active).toBe(true);
    expect(state.writes).toBe(0);
  });
  it("F063: current generation can leave", async () => {
    state.admin = admin;
    state.current = { teamId: "team", active: true, tokenGen: 1 };
    expect(await deactivateTeamMemberIfGeneration("member", "team", 1)).toBe("left");
    expect(state.current.active).toBe(false);
  });
  it("F062: retries the sweep against concurrent post, status and personnel edits", async () => {
    state.admin = admin;
    state.current = { posts: [{ id: "p", status: "active", personnel: [{ agentId: "deleted" }] }], saved: true };
    state.onRead = () => {
      state.current = { posts: [
        { id: "p", status: "maintenance", personnel: [{ agentId: "deleted" }, { agentId: "other" }] },
        { id: "new", personnel: [] },
      ], saved: false };
      state.version++;
    };
    expect(await removeAgentFromRosterDay("units/u/rosterDays", "day", "deleted")).toBe(true);
    expect(state.current).toMatchObject({ posts: [
      { id: "p", status: "maintenance", personnel: [{ agentId: "other" }] },
      { id: "new", personnel: [] },
    ], saved: false });
  });
});
