import { describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

vi.stubGlobal("indexedDB", undefined);


// ARC-M13: the relay confirms delivery only when the 200 response body
// satisfies the report contract (the server echoes the stored report), so
// these mocks model that body instead of a body-less 200.
let ok200Seq = 0;
function ok200(): Response {
  ok200Seq += 1;
  return new Response(JSON.stringify({
    id: `srv-relay-${ok200Seq}`,
    lat: 36.75,
    lng: 3.06,
    locationName: "Test location",
    wilaya: "Alger",
    description: "Relayed mesh report body",
    severity: "medium",
    status: "pending",
    timestamp: new Date().toISOString(),
    consensusCount: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function journalFor(item: { id: string; report: Record<string, unknown> }, state: "prepared" | "delivered") {
  return {
    journalId: `journal-${item.id}`,
    queueItemId: item.id,
    storageReplica: "co_located" as const,
    baseQueueRevision: 50,
    clientGeneratedId: item.report.clientGeneratedId,
    reportFingerprint: "fixture-fingerprint",
    report: item.report,
    state,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("mesh relay capacity recovery after reload", () => {
  it("reconstructs a protected prepared item after capacity overflow and commits it once", async () => {
    storage.clear();
    vi.resetModules();
    const firstSession = await import("../src/lib/meshRelay.js");
    for (let index = 0; index < 50; index++) {
      await firstSession.enqueueRelay({ clientGeneratedId: `reload-capacity-${index}` });
    }

    const beforeOverflow = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    const protectedItem = beforeOverflow.pending[0];
    beforeOverflow.journal = [journalFor(protectedItem, "prepared")];
    storage.set("mesh_relay_queue", JSON.stringify(beforeOverflow));
    await firstSession.enqueueRelay({ clientGeneratedId: "reload-capacity-new" });

    const afterOverflow = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    expect(afterOverflow.deadLetters.some((item: { report: { clientGeneratedId: string } }) =>
      item.report.clientGeneratedId === protectedItem.report.clientGeneratedId
    )).toBe(false);
    expect(afterOverflow.deadLetters).toHaveLength(1);

    vi.resetModules();
    const secondSession = await import("../src/lib/meshRelay.js");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok200())
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await secondSession.flushQueue();

    const recovered = JSON.parse(storage.get("mesh_relay_queue") || "{}");
    expect(fetchMock).toHaveBeenCalled();
    expect(recovered.pending.some((item: { report: { clientGeneratedId: string } }) =>
      item.report.clientGeneratedId === protectedItem.report.clientGeneratedId
    )).toBe(false);
    expect(recovered.deadLetters.some((item: { report: { clientGeneratedId: string } }) =>
      item.report.clientGeneratedId === protectedItem.report.clientGeneratedId
    )).toBe(false);
    expect(recovered.journal.find((entry: { queueItemId: string }) => entry.queueItemId === protectedItem.id)?.state)
      .toBe("committed");
  });
});
