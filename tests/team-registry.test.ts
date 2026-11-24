import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * T5 (Phase-1 critique test gap): teamRegistry internals — the live-layer
 * rules the route tests only brush against. fs is mocked at the boundary;
 * the registry logic (trail cap, trail gates, online window, eviction,
 * snapshot throttle) runs REAL.
 */

const fsMock = vi.hoisted(() => ({
  docMergeTeamPositionIfActive: vi.fn(async (..._a: any[]) => true as any),
}));

vi.mock("../server/fs.js", () => fsMock);

// Fix 45 (TRG-2): teamRegistry imports the real pino logger; the warn
// assertion needs the mock (same hoisted pattern as fsMock).
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../server/logger.js", () => ({ default: loggerMock }));

import {
  clearRegistry,
  isOnline,
  listPositions,
  recordHeartbeat,
  removeMember,
  snapshotIfDue,
} from "../server/teamRegistry.js";

beforeEach(() => {
  clearRegistry();
  fsMock.docMergeTeamPositionIfActive.mockReset().mockResolvedValue(true);
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
  loggerMock.info.mockClear();
  loggerMock.debug.mockClear();
});

const ping = (memberId: string, lat: number, lng: number, now: number) =>
  recordHeartbeat({ memberId, teamId: "team-t5", name: `عضو ${memberId}`, lat, lng, now });

describe("teamRegistry — trail rules", () => {
  it("caps the breadcrumb trail at 50 points, dropping the OLDEST", () => {
    const base = Date.now(); // real clock: listPositions() evicts vs Date.now()
    // 70 pings, each >20m apart and >10s apart → each one appends a point.
    for (let i = 0; i < 70; i += 1) ping("tm-trail", 36.7 + i * 0.001, 5.0, base + i * 20_000);
    const live = listPositions({ teamId: "team-t5" })[0];
    expect(live.trail).toHaveLength(50);
    // The first surviving point is ping #20 (indices 0..19 were dropped).
    expect(live.trail[0].t).toBe(base + 20 * 20_000);
    expect(live.trail.at(-1)!.t).toBe(base + 69 * 20_000);
  });

  it("skips trail points that are neither 20m away nor 10s apart (stationary member)", () => {
    const base = Date.now();
    ping("tm-still", 36.7, 5.0, base);
    const second = ping("tm-still", 36.700001, 5.0, base + 1_000); // ~0.1m after 1s → no new point
    expect(second.trail).toHaveLength(1);
    const third = ping("tm-still", 36.700002, 5.0, base + 11_000); // ~0.2m but >10s → gap rule appends
    expect(third.trail).toHaveLength(2);
  });
});

describe("teamRegistry — online window and eviction", () => {
  it("isOnline: within 90s only", () => {
    const now = 5_000_000;
    expect(isOnline(now - 89_000, now)).toBe(true);
    expect(isOnline(now - 91_000, now)).toBe(false);
  });

  it("listPositions evicts entries silent for 30 minutes and filters by teamId", () => {
    const base = Date.now();
    ping("tm-evict", 36.7, 5.0, base);
    ping("tm-keep", 36.8, 5.0, base + 29 * 60_000); // fresh until minute 59
    recordHeartbeat({ memberId: "tm-other-team", teamId: "team-OTHER", name: "بعيد", lat: 36.9, lng: 5.0, now: base + 29 * 60_000 });

    // 31 minutes in: tm-evict (silent 31min) is evicted; the others (silent 2min) survive.
    // NOTE the order: the team-filtered read FIRST — listPositions mutates on
    // read (prunes expired entries), so the eviction read below is terminal.
    const filtered = listPositions({ teamId: "team-t5", now: base + 29 * 60_000 });
    expect(filtered.map((m) => m.memberId).sort()).toEqual(["tm-evict", "tm-keep"]);
    const later = listPositions({ now: base + 31 * 60_000 });
    expect(later.map((m) => m.memberId).sort()).toEqual(["tm-keep", "tm-other-team"]);
  });

  it("removeMember drops the live entry (and its trail) immediately", () => {
    const base = Date.now();
    ping("tm-gone", 36.7, 5.0, base);
    expect(listPositions()).toHaveLength(1);
    removeMember("tm-gone");
    expect(listPositions()).toHaveLength(0);
  });
});

describe("teamRegistry — snapshot throttle (durable layer)", () => {
  it("writes at most one snapshot per member per 5 minutes, carrying only display fields", () => {
    const base = Date.now();
    ping("tm-snap", 36.7, 5.0, base);
    snapshotIfDue("tm-snap", "team-t5", base);
    expect(fsMock.docMergeTeamPositionIfActive).toHaveBeenCalledTimes(1);

    // Two more pings + snapshot attempts inside the window → zero extra writes.
    ping("tm-snap", 36.71, 5.0, base + 60_000);
    snapshotIfDue("tm-snap", "team-t5", base + 60_000);
    snapshotIfDue("tm-snap", "team-t5", base + 299_000);
    expect(fsMock.docMergeTeamPositionIfActive).toHaveBeenCalledTimes(1);

    // After the window, the next snapshot lands with the FRESH position.
    ping("tm-snap", 36.72, 5.0, base + 301_000);
    snapshotIfDue("tm-snap", "team-t5", base + 301_000);
    expect(fsMock.docMergeTeamPositionIfActive).toHaveBeenCalledTimes(2);
    const payload = fsMock.docMergeTeamPositionIfActive.mock.calls[1][3] as Record<string, unknown>;
    expect(payload.lastKnownLat).toBeCloseTo(36.72);
    // B1/R1 contract: display fields ONLY — never authority fields.
    // Fix 45 (D5): the payload also carries the fix age (null for legacy).
    expect(Object.keys(payload).sort()).toEqual(["lastFixTimeMs", "lastKnownLat", "lastKnownLng", "lastSeenAt", "memberId", "name", "teamId"]);
  });

  it("does not snapshot a member that never heartbeated", () => {
    snapshotIfDue("tm-unknown", "team-t5", 1_000);
    expect(fsMock.docMergeTeamPositionIfActive).not.toHaveBeenCalled();
  });

  it("Fix 45 (TRG-2): a failed snapshot retries on the next heartbeat", async () => {
    const base = Date.now();
    fsMock.docMergeTeamPositionIfActive.mockResolvedValueOnce(false);
    ping("tm-retry", 36.7, 5.0, base);
    snapshotIfDue("tm-retry", "team-t5", base);
    // snapshotIfDue is fire-and-forget: flush the promise chain BEFORE the
    // second attempt, or the .then reset has not run yet and the test fails
    // on NEW code too (prep §4 harness trap).
    await new Promise((r) => setTimeout(r, 0));
    ping("tm-retry", 36.71, 5.0, base + 60_000);
    snapshotIfDue("tm-retry", "team-t5", base + 60_000);
    expect(fsMock.docMergeTeamPositionIfActive).toHaveBeenCalledTimes(2);
  });

  it("Fix 45 (TRG-2): a failed snapshot warns at the registry level", async () => {
    const base = Date.now();
    fsMock.docMergeTeamPositionIfActive.mockResolvedValueOnce(false);
    ping("tm-warn", 36.7, 5.0, base);
    snapshotIfDue("tm-warn", "team-t5", base);
    await new Promise((r) => setTimeout(r, 0));
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "tm-warn" }),
      "Team position snapshot failed"
    );
  });

  it("Fix 45 (TRG-2): the retry still happens when a heartbeat replaced the entry mid-flight", async () => {
    const base = Date.now();
    let resolveGate!: (v: boolean) => void;
    const gate = new Promise<boolean>((res) => {
      resolveGate = res;
    });
    fsMock.docMergeTeamPositionIfActive.mockResolvedValueOnce(gate);
    ping("tm-stale", 36.7, 5.0, base);
    snapshotIfDue("tm-stale", "team-t5", base);
    // A heartbeat lands while the write is in flight — recordHeartbeat
    // replaces the registry entry object (copying lastSnapshotAt). The
    // reset must land on the LIVE entry (registry.get), not the stale one
    // snapshotIfDue closed over — that is the §1.2 trap this test pins.
    ping("tm-stale", 36.71, 5.0, base + 15_000);
    resolveGate(false);
    await new Promise((r) => setTimeout(r, 0));
    snapshotIfDue("tm-stale", "team-t5", base + 60_000);
    expect(fsMock.docMergeTeamPositionIfActive).toHaveBeenCalledTimes(2);
  });

  it("Fix 45 (D5): the snapshot payload carries the fix age, null for legacy clients", async () => {
    const base = Date.now();
    recordHeartbeat({
      memberId: "tm-fixage",
      teamId: "team-t5",
      name: "عضو",
      lat: 36.7,
      lng: 5.0,
      fixTimeMs: base - 2_000,
      now: base,
    });
    snapshotIfDue("tm-fixage", "team-t5", base);
    await new Promise((r) => setTimeout(r, 0));
    const payload = fsMock.docMergeTeamPositionIfActive.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.lastFixTimeMs).toBe(base - 2_000);
    // Control: a legacy client without fixTimeMs → null, never fabricated.
    recordHeartbeat({ memberId: "tm-fixage-legacy", teamId: "team-t5", name: "عضو قديم", lat: 36.7, lng: 5.0, now: base });
    snapshotIfDue("tm-fixage-legacy", "team-t5", base);
    await new Promise((r) => setTimeout(r, 0));
    const legacyPayload = fsMock.docMergeTeamPositionIfActive.mock.calls[1][3] as Record<string, unknown>;
    expect(legacyPayload.lastFixTimeMs).toBeNull();
  });
});

describe("teamRegistry — F10 fix-time plumbing", () => {
  it("stores fixTimeMs when the client reports its GPS fix epoch", () => {
    const now = Date.now();
    recordHeartbeat({
      memberId: "tm-fixtime",
      teamId: "team-t5",
      name: "عضو",
      lat: 36.7,
      lng: 5.0,
      fixTimeMs: now - 2_000,
      now,
    });
    const pos = listPositions({ teamId: "team-t5" })[0];
    expect(pos.fixTimeMs).toBe(now - 2_000);
  });

  it("keeps fixTimeMs null for legacy clients (never guesses an age)", () => {
    recordHeartbeat({
      memberId: "tm-legacy",
      teamId: "team-t5",
      name: "عضو قديم",
      lat: 36.7,
      lng: 5.0,
      now: Date.now(),
    });
    const pos = listPositions({ teamId: "team-t5" })[0];
    expect(pos.fixTimeMs).toBeNull();
  });
});
