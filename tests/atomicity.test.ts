import { describe, expect, it, vi } from "vitest";

type Doc = Record<string, any>;
type State = { docs: Map<string, Doc>; queue: Promise<void> };
const state = vi.hoisted<State>(() => ({ docs: new Map(), queue: Promise.resolve() }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => createDb(),
  isAdminDb: () => true,
}));

function snapshot(path: string) {
  const data = state.docs.get(path);
  return { exists: Boolean(data), id: path.split("/").at(-1), data: () => data };
}

function createDb() {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          const path = `${name}/${id}`;
          return { id, path, get: async () => snapshot(path) };
        },
      };
    },
    async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const previous = state.queue;
      let release!: () => void;
      state.queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const writes: Array<{ kind: "create" | "set" | "update"; path: string; data: Doc }> = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        create: (ref: { path: string }, data: Doc) => writes.push({ kind: "create", path: ref.path, data }),
        set: (ref: { path: string }, data: Doc) => writes.push({ kind: "set", path: ref.path, data }),
        update: (ref: { path: string }, data: Doc) => writes.push({ kind: "update", path: ref.path, data }),
      };
      try {
        const result = await callback(tx);
        for (const write of writes) {
          if (write.kind === "update") state.docs.set(write.path, { ...state.docs.get(write.path), ...write.data });
          else state.docs.set(write.path, write.data);
        }
        return result;
      } finally {
        release();
      }
    },
  };
}

const {
  createDocIfAbsent,
  appendRosterPostAtomic,
  approveVolunteerAtomically,
  createVolunteerRegistrationAtomically,
} = await import("../server/atomic.js");

const post = (id: string) => ({ id, labelAr: id, personnel: [] });
const registration = (id: string) => ({ id, status: "pending", wilaya: "Bordj Bou Arreridj", createdAt: "2026-08-24T00:00:00.000Z" });
const uniquenessKeys = { phoneHash: "phone-hash", emailHash: "email-hash", fullNameHash: "name-hash" };

describe("atomic persistence helpers", () => {
  it("allows only one concurrent create for a unique document", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const [first, second] = await Promise.all([
      createDocIfAbsent("users", "agent-atomic", { agentId: "agent-atomic" }),
      createDocIfAbsent("users", "agent-atomic", { agentId: "agent-atomic" }),
    ]);
    expect([first, second].sort()).toEqual(["created", "exists"]);
    expect(state.docs.get("users/agent-atomic")).toEqual({ agentId: "agent-atomic" });
  });

  it("preserves both concurrent roster appends instead of losing the last writer", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const first = appendRosterPostAtomic("units/unit-dz16/rosterDays", "2026-08-24", "unit-dz16", post("post-a"), 50);
    const second = appendRosterPostAtomic("units/unit-dz16/rosterDays", "2026-08-24", "unit-dz16", post("post-b"), 50);
    const results = await Promise.all([first, second]);
    expect(results).toEqual(["created", "created"]);
    expect(state.docs.get("units/unit-dz16/rosterDays/2026-08-24")?.posts.map((p: any) => p.id)).toEqual(["post-a", "post-b"]);
  });

  it("does not allow a concurrent roster append to exceed the post limit", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("units/unit-dz16/rosterDays/2026-08-24", { unitId: "unit-dz16", date: "2026-08-24", posts: [post("last-slot")] });
    const [first, second] = await Promise.all([
      appendRosterPostAtomic("units/unit-dz16/rosterDays", "2026-08-24", "unit-dz16", post("post-a"), 2),
      appendRosterPostAtomic("units/unit-dz16/rosterDays", "2026-08-24", "unit-dz16", post("post-b"), 2),
    ]);
    expect([first, second].filter((x) => x === "created")).toHaveLength(1);
    expect([first, second].filter((x) => x === "limit")).toHaveLength(1);
  });

  it("atomically creates only one registration for concurrent identical uniqueness keys", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const [first, second] = await Promise.all([
      createVolunteerRegistrationAtomically(registration("reg-a"), uniquenessKeys),
      createVolunteerRegistrationAtomically(registration("reg-b"), uniquenessKeys),
    ]);
    expect([first, second].sort()).toEqual(["created", "duplicate-phone"]);
    expect(state.docs.has("volunteerRegistrations/reg-a")).not.toBe(state.docs.has("volunteerRegistrations/reg-b"));
    expect(state.docs.get("volunteerRegistrationUniqueness/phone-phone-hash")).toMatchObject({ registrationId: expect.any(String), kind: "phone" });
  });

  it("releases uniqueness after a rejected registration", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("volunteerRegistrationUniqueness/phone-phone-hash", { registrationId: "reg-rejected", kind: "phone" });
    state.docs.set("volunteerRegistrationUniqueness/email-email-hash", { registrationId: "reg-rejected", kind: "email" });
    state.docs.set("volunteerRegistrationUniqueness/name-name-hash:Bordj Bou Arreridj", { registrationId: "reg-rejected", kind: "name" });
    state.docs.set("volunteerRegistrations/reg-rejected", { ...registration("reg-rejected"), status: "rejected" });
    const result = await createVolunteerRegistrationAtomically(registration("reg-new"), uniquenessKeys);
    expect(result).toBe("created");
    expect(state.docs.get("volunteerRegistrationUniqueness/phone-phone-hash")?.registrationId).toBe("reg-new");
  });

  it("allows the same name and wilaya after the 30-day window expires", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const oldCreatedAt = "2026-07-01T00:00:00.000Z";
    state.docs.set("volunteerRegistrationUniqueness/phone-old-phone", { registrationId: "reg-old-phone", kind: "phone", createdAt: oldCreatedAt });
    state.docs.set("volunteerRegistrationUniqueness/name-name-hash:Bordj Bou Arreridj", {
      registrationId: "reg-old-name",
      kind: "name",
      createdAt: oldCreatedAt,
      expiresAt: Date.now() - 1,
    });
    state.docs.set("volunteerRegistrations/reg-old-phone", { id: "reg-old-phone", status: "pending" });
    state.docs.set("volunteerRegistrations/reg-old-name", { id: "reg-old-name", status: "pending", createdAt: oldCreatedAt, wilaya: "Bordj Bou Arreridj" });
    const result = await createVolunteerRegistrationAtomically(
      registration("reg-new-window"),
      { phoneHash: "new-phone", fullNameHash: "name-hash" },
    );
    expect(result).toBe("created");
  });

  it("atomically approves a volunteer with its badge", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("volunteerRegistrations/reg-atomic", { id: "reg-atomic", status: "pending" });
    const result = await approveVolunteerAtomically(
      "reg-atomic",
      { status: "approved", assignedCode: "VOLATOMIC" },
      "VOLATOMIC",
      { code: "VOLATOMIC", isActive: true },
    );
    expect(result).toBe("updated");
    expect(state.docs.get("volunteerRegistrations/reg-atomic")).toMatchObject({ status: "approved", assignedCode: "VOLATOMIC" });
    expect(state.docs.get("badgeCodes/VOLATOMIC")).toMatchObject({ code: "VOLATOMIC", isActive: true });
  });

  it("leaves the registration unchanged when the badge code wins a concurrent race", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("volunteerRegistrations/reg-a", { id: "reg-a", status: "pending" });
    state.docs.set("volunteerRegistrations/reg-b", { id: "reg-b", status: "pending" });
    const [first, second] = await Promise.all([
      approveVolunteerAtomically("reg-a", { status: "approved", assignedCode: "RACE01" }, "RACE01", { code: "RACE01" }),
      approveVolunteerAtomically("reg-b", { status: "approved", assignedCode: "RACE01" }, "RACE01", { code: "RACE01" }),
    ]);
    expect([first, second].sort()).toEqual(["badge-exists", "updated"]);
    const approved = [state.docs.get("volunteerRegistrations/reg-a"), state.docs.get("volunteerRegistrations/reg-b")].filter((r) => r?.status === "approved");
    expect(approved).toHaveLength(1);
  });
});
