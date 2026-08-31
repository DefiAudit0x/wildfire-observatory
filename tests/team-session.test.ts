import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildNativeTrackingConfig,
  clampHeartbeatInterval,
  clearTeamSession,
  flipMissionOnScene,
  getTeamTrackingBridge,
  joinTeam,
  leaveTeam,
  loadTeamSession,
  probeTeamSession,
  saveTeamSession,
  sendTeamHeartbeat,
  TeamSessionState,
} from "../src/utils/teamSession";

/**
 * Phase 2 — teamSession client logic: the persisted session shape, the
 * verdict classification of every hardened /api/teams endpoint (fatal vs
 * transient), and the native (Android FGS) bridge feature detection.
 *
 * The verdict rules are load-bearing: a needless local logout forces a code
 * re-join and burns the join-code budget (Round B), while a missed real
 * revocation keeps a dead device streaming. Both directions are pinned here.
 */

const SESSION: TeamSessionState = {
  token: "tok-abc",
  memberId: "tm-1234abcd5678efgh",
  teamId: "team-a1",
  teamName: "Unité Béjaïa",
  teamNameAr: "وحدة بجاية",
  name: "عارة 1",
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 400,
    status,
    json: async () => body,
  };
}

const fetchMock = vi.fn();

// This spec intentionally runs in BOTH suites (vitest.config.ts jsdom AND
// vitest.server.config.ts node — the house cross-environment net). Node has
// no sessionStorage, so a minimal in-memory polyfill keeps the persistence
// specs meaningful there too (teamSession.ts itself is already dual-env safe).
if (typeof (globalThis as any).sessionStorage === "undefined") {
  const mem = new Map<string, string>();
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => void mem.clear(),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("teamSession persistence", () => {
  it("round-trips a session through sessionStorage", () => {
    expect(loadTeamSession()).toBeNull();
    saveTeamSession(SESSION);
    expect(loadTeamSession()).toEqual(SESSION);
    clearTeamSession();
    expect(loadTeamSession()).toBeNull();
  });

  it("rejects a corrupted or incomplete stored session instead of crashing", () => {
    sessionStorage.setItem("observatory_team_session", "{not json");
    expect(loadTeamSession()).toBeNull();
    sessionStorage.setItem("observatory_team_session", JSON.stringify({ token: "x" }));
    expect(loadTeamSession()).toBeNull();
  });
});

describe("clampHeartbeatInterval", () => {
  it("clamps server pacing into the 10s–60s window and defaults garbage to 15s", () => {
    expect(clampHeartbeatInterval(15_000)).toBe(15_000);
    expect(clampHeartbeatInterval(2_000)).toBe(10_000);
    expect(clampHeartbeatInterval(120_000)).toBe(60_000);
    expect(clampHeartbeatInterval("abc")).toBe(15_000);
    expect(clampHeartbeatInterval(undefined)).toBe(15_000);
  });
});

describe("joinTeam", () => {
  it("stores nothing itself but returns a ready session on success", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        memberId: "tm-x",
        teamId: "team-a1",
        teamName: "Unité 1",
        teamNameAr: "وحدة 1",
        name: "عارة 1",
        token: "tok-1",
        tokenTtlSeconds: 43200,
        mission: { sosId: "sos-1", phase: "en_route", since: 42 },
        heartbeatIntervalMs: 15_000,
      })
    );
    const result = await joinTeam("A2B4C6D8", "عارة 1");
    expect(result.ok).toBe(true);
    expect(result.session).toEqual({
      token: "tok-1",
      memberId: "tm-x",
      teamId: "team-a1",
      teamName: "Unité 1",
      teamNameAr: "وحدة 1",
      name: "عارة 1",
    });
    expect(result.mission).toEqual({ sosId: "sos-1", phase: "en_route", since: 42 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/teams/join");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ code: "A2B4C6D8", name: "عارة 1" });
    // join rides the public-principal cookie (CSRF pass-through)
    expect(init.credentials).toBe("same-origin");
  });

  it("surfaces the server's Arabic error text and flags transport failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "رمز الانضمام غير صالح (Invalid join code)" }));
    const bad = await joinTeam("WRONGCOD", "عارة 1");
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("رمز الانضمام");

    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const dead = await joinTeam("A2B4C6D8", "عارة 1");
    expect(dead).toEqual({ ok: false, message: "network" });

    // A 2xx without the required fields never yields a half session.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "tok-only" }));
    const hollow = await joinTeam("A2B4C6D8", "عارة 1");
    expect(hollow.ok).toBe(false);
  });
});

describe("probeTeamSession verdicts", () => {
  it("ok → restores mission and server pacing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        memberId: SESSION.memberId,
        teamId: SESSION.teamId,
        teamName: SESSION.teamName,
        teamNameAr: SESSION.teamNameAr,
        name: SESSION.name,
        mission: { sosId: "sos-9", phase: "on_scene", since: 7 },
        heartbeatIntervalMs: 30_000,
      })
    );
    const result = await probeTeamSession(SESSION.token);
    expect(result.ok).toBe(true);
    expect(result.mission).toEqual({ sosId: "sos-9", phase: "on_scene", since: 7 });
    expect(result.heartbeatIntervalMs).toBe(30_000);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${SESSION.token}`);
  });

  it("maps every fatal gate code the server can send", async () => {
    for (const code of ["MEMBER_REVOKED", "MEMBER_INACTIVE", "MEMBER_INVALID", "TEAM_INACTIVE"]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(403, { code, error: "gate" }));
      const result = await probeTeamSession(SESSION.token);
      expect(result.ok).toBe(false);
      expect(result.fatal).toBe(code);
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "expired" }));
    const expired = await probeTeamSession(SESSION.token);
    expect(expired.fatal).toBe("AUTH");
  });

  it("network failure is NOT a verdict — session survives with no fatal", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline tunnel"));
    const result = await probeTeamSession(SESSION.token);
    expect(result.ok).toBe(false);
    expect(result.fatal).toBeUndefined();
  });
});

describe("sendTeamHeartbeat verdicts", () => {
  const fix = { lat: 36.75, lng: 5.07, accuracy: 8, heading: 90, speed: 4.2 };

  it("sends only finite optional fields and returns the mission on ok", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, serverTime: 1, heartbeatIntervalMs: 15_000, mission: { sosId: "sos-1", phase: "en_route", since: 42 } })
    );
    const result = await sendTeamHeartbeat(SESSION.token, fix);
    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ lat: 36.75, lng: 5.07, accuracy: 8, heading: 90, speed: 4.2 });
  });

  it("treats 429 and 5xx as transient (session stays alive)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: "too frequent" }));
    expect(await sendTeamHeartbeat(SESSION.token, fix)).toEqual({ ok: false, transient: true });
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: "storage" }));
    expect(await sendTeamHeartbeat(SESSION.token, fix)).toEqual({ ok: false, transient: true });
  });

  it("treats gate rejections as fatal and transport errors as transient", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: "MEMBER_REVOKED", error: "revoked" }));
    const revoked = await sendTeamHeartbeat(SESSION.token, fix);
    expect(revoked.ok).toBe(false);
    expect((revoked as any).fatal).toBe("MEMBER_REVOKED");

    fetchMock.mockRejectedValueOnce(new TypeError("timeout"));
    expect(await sendTeamHeartbeat(SESSION.token, fix)).toEqual({ ok: false, transient: true });
  });

  it("a 400-class rejection (bad fix) is transient — the session NEVER dies for a payload problem", async () => {
    // NaN serializes to null in JSON; the server's zod gate would 400 it.
    // The verdict rules must keep the session: the next fix is a fresh one.
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "Coordinates are outside the coverage area" }));
    const result = await sendTeamHeartbeat(SESSION.token, { lat: Number.NaN, lng: 5.07 });
    expect(result).toEqual({ ok: false, transient: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.lat).toBeNull();
  });
});

describe("flipMissionOnScene + leaveTeam", () => {
  it("updates the mission on ok and maps 409 to NO_ACTIVE_MISSION", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, mission: { sosId: "sos-1", phase: "on_scene", since: 42 } }));
    const good = await flipMissionOnScene(SESSION.token);
    expect(good.ok).toBe(true);
    expect(good.mission).toEqual({ sosId: "sos-1", phase: "on_scene", since: 42 });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ phase: "on_scene" });

    fetchMock.mockResolvedValueOnce(jsonResponse(409, { code: "NO_ACTIVE_MISSION", error: "none" }));
    expect((await flipMissionOnScene(SESSION.token)).code).toBe("NO_ACTIVE_MISSION");
  });

  it("leaveTeam: ok on success AND on already-gone gates; transient on network death", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    expect(await leaveTeam(SESSION.token)).toEqual({ ok: true });
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: "MEMBER_REVOKED", error: "gone" }));
    expect((await leaveTeam(SESSION.token)).ok).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await leaveTeam(SESSION.token)).toEqual({ ok: false, transient: true });
  });
});

describe("native FGS bridge detection", () => {
  it("returns null without an Android bridge or with a partial surface", () => {
    expect(getTeamTrackingBridge()).toBeNull();
    (globalThis as any).AndroidBridge = { startTeamTracking: vi.fn() };
    expect(getTeamTrackingBridge()).toBeNull();
    delete (globalThis as any).AndroidBridge;
  });

  it("returns the bridge when the full Phase 2 surface exists and serializes its config", () => {
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking: vi.fn(),
    };
    const bridge = getTeamTrackingBridge();
    expect(bridge).not.toBeNull();
    const config = JSON.parse(buildNativeTrackingConfig(SESSION, 2_000));
    // clamped into the safe window; token/memberId/teamId travel ONCE at start
    expect(config.intervalMs).toBe(10_000);
    expect(config.token).toBe(SESSION.token);
    expect(config.memberId).toBe(SESSION.memberId);
    expect(config.teamId).toBe(SESSION.teamId);
    expect(typeof config.baseUrl).toBe("string");
    delete (globalThis as any).AndroidBridge;
  });
});
