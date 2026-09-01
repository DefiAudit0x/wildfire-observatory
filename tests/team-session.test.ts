import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ARRIVAL_RADIUS_M,
  ARRIVAL_STREAK_NEEDED,
  buildNavigationUrl,
  buildNativeTrackingConfig,
  clampHeartbeatInterval,
  clearTeamSession,
  distanceMeters,
  flipMissionOnScene,
  getTeamTrackingBridge,
  joinTeam,
  leaveTeam,
  loadTeamSession,
  normalizeNativeMission,
  openMissionNavigation,
  probeTeamSession,
  saveTeamSession,
  sendTeamHeartbeat,
  updateArrivalStreak,
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

describe("normalizeNativeMission (F3/S5 — native beat payload channel)", () => {
  it("parses the quoted mission JSON through the same allow-list as server responses", () => {
    expect(normalizeNativeMission('{"sosId":"sos-9","phase":"on_scene","since":77}')).toEqual({
      sosId: "sos-9",
      phase: "on_scene",
      since: 77,
      sosLat: null,
      sosLng: null,
    });
    // cleared missions normalize to null, exactly like server traffic
    expect(normalizeNativeMission('{"sosId":"sos-9","phase":"cleared","since":77}')).toBeNull();
    // extra hostile fields are dropped by the allow-list, never propagated
    expect(normalizeNativeMission('{"sosId":"sos-9","phase":"en_route","since":1,"__proto__":{"x":1},"html":"<img>"}')).toEqual({
      sosId: "sos-9",
      phase: "en_route",
      since: 1,
      sosLat: null,
      sosLng: null,
    });
  });

  it("degrades null/absent/malformed payloads to null instead of crashing the panel", () => {
    expect(normalizeNativeMission(null)).toBeNull();
    expect(normalizeNativeMission(undefined)).toBeNull();
    expect(normalizeNativeMission("")).toBeNull();
    expect(normalizeNativeMission("{not json")).toBeNull();
    expect(normalizeNativeMission('{"no sosId":true}')).toBeNull();
    expect(normalizeNativeMission("42")).toBeNull();
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
    expect(result.mission).toEqual({ sosId: "sos-1", phase: "en_route", since: 42, sosLat: null, sosLng: null });
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
    expect(result.mission).toEqual({ sosId: "sos-9", phase: "on_scene", since: 7, sosLat: null, sosLng: null });
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
    expect(result).toEqual({
      ok: true,
      mission: { sosId: "sos-1", phase: "en_route", since: 42, sosLat: null, sosLng: null },
      heartbeatIntervalMs: 15_000,
    });
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
    expect(good.mission).toEqual({ sosId: "sos-1", phase: "on_scene", since: 42, sosLat: null, sosLng: null });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ phase: "on_scene" });

    fetchMock.mockResolvedValueOnce(jsonResponse(409, { code: "NO_ACTIVE_MISSION", error: "none" }));
    expect((await flipMissionOnScene(SESSION.token)).code).toBe("NO_ACTIVE_MISSION");
  });

  it("Phase 3: the evidence flip carries the fix, and a 400 ARRIVAL_* maps to rejected (never fatal)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, mission: { sosId: "sos-1", phase: "on_scene", since: 42 } }));
    const good = await flipMissionOnScene(SESSION.token, { lat: 36.7501, lng: 5.0702, accuracy: 9.5 });
    expect(good.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ phase: "on_scene", lat: 36.7501, lng: 5.0702, accuracy: 9.5 });

    // accuracy: null must be OMITTED (same omit-optional doctrine as the beat)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, mission: null }));
    await flipMissionOnScene(SESSION.token, { lat: 36.7501, lng: 5.0702, accuracy: null });
    const [, init2] = fetchMock.mock.calls[1];
    expect(JSON.parse(init2.body)).toEqual({ phase: "on_scene", lat: 36.7501, lng: 5.0702 });

    // Server-side geometry rejected the evidence — transient-class, session intact
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { code: "ARRIVAL_TOO_FAR", error: "أنت لا تزال بعيداً عن موقع البلاغ" }));
    const rejected = await flipMissionOnScene(SESSION.token, { lat: 36.7, lng: 5.07 });
    expect(rejected).toEqual({ ok: false, code: "rejected" });
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

// ========================
// PHASE 3 — arrival geometry + mission navigation
// ========================
describe("Phase 3 — arrival geometry", () => {
  it("distanceMeters: zero at the same point, ~1112m per 0.01° latitude, server-parity", () => {
    expect(distanceMeters(36.75, 5.07, 36.75, 5.07)).toBe(0);
    // One degree of latitude ≈ 111.19 km → 0.01° ≈ 1111.9 m
    const perCent = distanceMeters(36.75, 5.07, 36.76, 5.07);
    expect(perCent).toBeGreaterThan(1100);
    expect(perCent).toBeLessThan(1125);
    // Symmetric
    expect(distanceMeters(36.75, 5.07, 36.7601, 5.07)).toBeCloseTo(distanceMeters(36.7601, 5.07, 36.75, 5.07), 6);
  });

  it("arrival streak counts consecutive in-range fixes and resets on any out-of-range fix", () => {
    expect(ARRIVAL_STREAK_NEEDED).toBe(2);
    expect(ARRIVAL_RADIUS_M).toBe(50);
    let s = 0;
    s = updateArrivalStreak(s, true); // fix 1 in range
    expect(s).toBe(1);
    s = updateArrivalStreak(s, true); // fix 2 in range → gate opens
    expect(s).toBe(2);
    s = updateArrivalStreak(s, true); // (already arrived — caller resets, streak still counts)
    expect(s).toBe(3);
    s = updateArrivalStreak(s, false); // one stray jump → full reset, NOT decrement
    expect(s).toBe(0);
    s = updateArrivalStreak(s, true);
    expect(s).toBe(1);
  });

  it("normalizeMission sanitizes mission target coords (numbers, numeric strings, garbage → null)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        serverTime: 1,
        mission: { sosId: "sos-9", phase: "en_route", since: 7, sosLat: "36.7503", sosLng: 5.07 },
      })
    );
    const ok = await probeTeamSession(SESSION.token);
    expect(ok.mission?.sosLat).toBe(36.7503);
    expect(ok.mission?.sosLng).toBe(5.07);

    for (const bad of [Number.NaN, Infinity, "", "abc", true, {}, null]) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { ok: true, serverTime: 1, mission: { sosId: "sos-9", phase: "en_route", since: 7, sosLat: bad, sosLng: bad } })
      );
      const res = await probeTeamSession(SESSION.token);
      expect(res.mission?.sosLat).toBeNull();
      expect(res.mission?.sosLng).toBeNull();
    }
  });
});

describe("Phase 3 — mission navigation", () => {
  it("builds the universal Google Maps directions URL", () => {
    expect(buildNavigationUrl(36.7503, 5.0702)).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=36.7503,5.0702&travelmode=driving"
    );
  });

  it("prefers the origin-gated bridge when it exposes openNavigation", () => {
    const bridgeNav = vi.fn((..._args: any[]) => true);
    const openSpy = vi.fn((..._args: any[]) => null as unknown as Window);
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking: vi.fn(),
      openNavigation: bridgeNav,
    };
    vi.stubGlobal("open", openSpy);
    try {
      const opened = openMissionNavigation({ sosLat: 36.7503, sosLng: 5.0702 });
      expect(opened).toBe(true);
      expect(bridgeNav).toHaveBeenCalledTimes(1);
      expect(JSON.parse(bridgeNav.mock.calls[0][0])).toEqual({ lat: 36.7503, lng: 5.0702 });
      expect(openSpy).not.toHaveBeenCalled(); // the WebView never window.opens across the bridge
    } finally {
      delete (globalThis as any).AndroidBridge;
      vi.unstubAllGlobals();
    }
  });

  it("falls back to window.open(noopener) in a plain browser, honestly reporting failure", () => {
    const openSpy = vi.fn((..._args: any[]) => null as unknown as Window); // popup blocked
    // Dual-env safe: node has no window — openMissionNavigation must find
    // window.open through the SAME stubbed global in BOTH suites.
    vi.stubGlobal("window", { open: openSpy });
    try {
      expect(openMissionNavigation({ sosLat: 36.7503, sosLng: 5.0702 })).toBe(false);
      expect(openSpy.mock.calls[0][1]).toBe("_blank");
      expect(openSpy.mock.calls[0][2]).toContain("noopener");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to navigate without a usable target (legacy mission)", () => {
    expect(openMissionNavigation({ sosLat: null, sosLng: null })).toBe(false);
    expect(openMissionNavigation({ sosLat: Number.NaN, sosLng: 5.07 })).toBe(false);
  });
});
