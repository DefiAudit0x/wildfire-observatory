import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import TeamPanel from "../../src/components/TeamPanel";

/**
 * Phase 2 — TeamPanel component specs: join flow, resume-probe verdicts,
 * mission display + on_scene flip, native (Android FGS) card behavior.
 * The network boundary (global fetch) and navigator.geolocation are stubbed;
 * assertions pin the UI contract and the fetch routing, not the HTTP client
 * (covered by tests/team-session.test.ts).
 */

const SESSION = {
  token: "tok-1",
  memberId: "tm-1",
  teamId: "team-a1",
  teamName: "Unité Béjaïa",
  teamNameAr: "وحدة بجاية",
  name: "عارة 1",
};

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 400, status, json: async () => body };
}

// Loose typing is deliberate: the mock's call ledger is asserted by URL/body
// across five endpoints, and a strict vi.fn() signature types calls as [].
const fetchMock: any = vi.fn(async (..._args: any[]) => ({ ok: false, status: 404, json: async () => ({}) }));

/** Routes each fetch call by URL so tests stay readable. */
function routeFetch() {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === "/api/teams/join") {
      if (body.code === "A2B4C6D8" && body.name === "عارة 1") {
        return jsonRes(200, { ...SESSION, tokenTtlSeconds: 43200, mission: { sosId: "sos-77", phase: "en_route", since: 1000 }, heartbeatIntervalMs: 15000 });
      }
      return jsonRes(404, { error: "رمز الانضمام غير صالح (Invalid join code)" });
    }
    if (url === "/api/teams/session") {
      return jsonRes(200, { ...SESSION, mission: { sosId: "sos-77", phase: "en_route", since: 1000 }, heartbeatIntervalMs: 15000 });
    }
    if (url === "/api/teams/heartbeat") {
      return jsonRes(200, { ok: true, serverTime: Date.now(), heartbeatIntervalMs: 15000, mission: { sosId: "sos-77", phase: "en_route", since: 1000 } });
    }
    if (url === "/api/teams/mission/phase") {
      return jsonRes(200, { ok: true, mission: { sosId: "sos-77", phase: "on_scene", since: 1000 } });
    }
    if (url === "/api/teams/leave") {
      return jsonRes(200, { ok: true });
    }
    return jsonRes(404, { error: "no route" });
  });
}

function seedSession() {
  sessionStorage.setItem("observatory_team_session", JSON.stringify(SESSION));
}

function stubGeolocation(fix: Partial<GeolocationCoordinates> = {}) {
  Object.defineProperty(window.navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (p: GeolocationPosition) => void) =>
        ok({
          coords: { latitude: 36.75, longitude: 5.07, accuracy: 8, heading: 90, speed: 4, altitude: null, altitudeAccuracy: null, latitudeErr: undefined, longitudeErr: undefined } as any,
          timestamp: Date.now(),
        } as GeolocationPosition),
      watchPosition: () => 1,
      clearWatch: () => {},
    },
  });
  void fix;
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  routeFetch();
  // count-based specs must never see ANOTHER spec's fetch ledger — restoreAllMocks
  // clears spy history but does not reset a bare vi.fn() call ledger.
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  stubGeolocation();
  (globalThis as any).AndroidBridge = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TeamPanel — guest view", () => {
  it("renders the join form and joins by code, then shows the team identity and mission", async () => {
    render(<TeamPanel lang="ar" />);
    expect(screen.getByLabelText(/رمز الفريق/)).toBeTruthy();
    expect(screen.getByLabelText(/الاسم الظاهر/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/رمز الفريق/), { target: { value: "a2b4c6d8" } });
    fireEvent.change(screen.getByLabelText(/الاسم الظاهر/), { target: { value: "عارة 1" } });
    fireEvent.click(screen.getByRole("button", { name: /انضمام إلى الفريق/ }));

    await waitFor(() => expect(screen.getByText("وحدة بجاية")).toBeTruthy());
    expect(screen.getByText(/في الطريق إلى الموقع/)).toBeTruthy();
    // the session persisted for reload-resume
    expect(JSON.parse(sessionStorage.getItem("observatory_team_session") || "{}").token).toBe("tok-1");
    // join carries the normalized code
    const [joinUrl, joinInit] = (fetchMock.mock.calls.find(([u]: any[]) => u === "/api/teams/join") ?? ["", {}]) as [string, RequestInit];
    expect(joinUrl).toBe("/api/teams/join");
    expect(JSON.parse(String(joinInit.body)).code).toBe("A2B4C6D8");
  });

  it("surfaces the server's invalid-code error without storing a session", async () => {
    render(<TeamPanel lang="ar" />);
    fireEvent.change(screen.getByLabelText(/رمز الفريق/), { target: { value: "WRONGCOD" } });
    fireEvent.change(screen.getByLabelText(/الاسم الظاهر/), { target: { value: "عارة 1" } });
    fireEvent.click(screen.getByRole("button", { name: /انضمام إلى الفريق/ }));
    await waitFor(() => expect(screen.getByText(/رمز الانضمام غير صالح/)).toBeTruthy());
    expect(sessionStorage.getItem("observatory_team_session")).toBeNull();
  });
});

describe("TeamPanel — resume probe", () => {
  it("restores the session from sessionStorage and keeps the loop alive", async () => {
    seedSession();
    render(<TeamPanel lang="ar" />);
    await waitFor(() => expect(screen.getByText("وحدة بجاية")).toBeTruthy());
    expect(screen.getByText(/المهمة الحالية/)).toBeTruthy();
  });

  it("clears the session on MEMBER_REVOKED and explains why (join-code budget stays intact)", async () => {
    seedSession();
    fetchMock.mockImplementationOnce(async () => jsonRes(403, { code: "MEMBER_REVOKED", error: "revoked" }));
    render(<TeamPanel lang="ar" />);
    await waitFor(() => expect(screen.getByText(/أُلغيت عضويتك من قِبل قيادة الحملة/)).toBeTruthy());
    // back to the join form; the dead token is gone
    expect(screen.getByLabelText(/رمز الفريق/)).toBeTruthy();
    expect(sessionStorage.getItem("observatory_team_session")).toBeNull();
  });

  it("keeps the session when the probe hits a network failure (no verdict)", async () => {
    seedSession();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    render(<TeamPanel lang="ar" />);
    await waitFor(() => expect(screen.getByText("وحدة بجاية")).toBeTruthy());
    expect(sessionStorage.getItem("observatory_team_session")).not.toBeNull();
  });
});

describe("TeamPanel — mission surface", () => {
  it("flips en_route → on_scene and renders the arrival state", async () => {
    seedSession();
    render(<TeamPanel lang="ar" />);
    const flip = await screen.findByRole("button", { name: /وصلت إلى الموقع/ });
    fireEvent.click(flip);
    await waitFor(() => expect(screen.getByText(/في موقع الحادث/)).toBeTruthy());
    const phaseCall = fetchMock.mock.calls.find(([u]: any[]) => u === "/api/teams/mission/phase");
    expect(JSON.parse(String(phaseCall?.[1]?.body))).toEqual({ phase: "on_scene" });
  });

  it("sends browser heartbeats while no native FGS is active (immediate first beat)", async () => {
    seedSession();
    render(<TeamPanel lang="ar" />);
    await waitFor(() => {
      const hb = fetchMock.mock.calls.find(([u]: any[]) => u === "/api/teams/heartbeat");
      expect(hb).toBeTruthy();
    });
    const [, init] = fetchMock.mock.calls.find(([u]: any[]) => u === "/api/teams/heartbeat")!;
    const body = JSON.parse(String(init?.body));
    expect(body.lat).toBeCloseTo(36.75);
    expect(init!.headers!.Authorization).toBe("Bearer tok-1");
  });

  it("leave flow confirms first, then clears the session", async () => {
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /الانسحاب من الفريق/ }));
    fireEvent.click(await screen.findByRole("button", { name: /نعم، انسحاب/ }));
    await waitFor(() => expect(screen.getByLabelText(/رمز الفريق/)).toBeTruthy());
    expect(sessionStorage.getItem("observatory_team_session")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]: any[]) => u === "/api/teams/leave")).toBe(true);
  });
});

describe("TeamPanel — native FGS integration", () => {
  it("shows the tracking card only when the bridge exists and hands it the config once", async () => {
    const startTeamTracking = vi.fn((cfg: string) => {
      expect(typeof cfg).toBe("string");
      return true;
    });
    const stopTeamTracking = vi.fn();
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking,
      stopTeamTracking,
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    const startBtn = await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ });
    // the browser loop's FIRST beat may already have fired pre-native — clear
    // the ledger, hand over to the FGS, and prove no NEW beat is produced.
    fetchMock.mockClear();
    fireEvent.click(startBtn);
    expect(startTeamTracking).toHaveBeenCalledTimes(1);
    const cfg = JSON.parse(startTeamTracking.mock.calls[0][0]);
    expect(cfg.token).toBe("tok-1");
    expect(cfg.memberId).toBe("tm-1");
    expect(cfg.teamId).toBe("team-a1");
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.some(([u]: any[]) => u === "/api/teams/heartbeat")).toBe(false);
  });

  it("stops the native service from the panel (after the native 'started' confirmation)", async () => {
    const stopTeamTracking = vi.fn();
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking,
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ }));
    // the panel never GUESSES the service state — it waits for the event
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "started" } }));
    fireEvent.click(await screen.findByRole("button", { name: /إيقاف التتبع الخلفي/ }));
    expect(stopTeamTracking).toHaveBeenCalledTimes(1);
  });

  it("shows permission guidance when the native start is refused", async () => {
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      teamTrackingPrerequisite: () => "missing-fine-location",
      startTeamTracking: vi.fn(() => false),
      stopTeamTracking: vi.fn(),
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ }));
    await waitFor(() => expect(screen.getByText(/إذن الموقع الدقيق غير مفعّل/)).toBeTruthy());
  });

  it("reacts to the native revoked event by clearing the session", async () => {
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking: vi.fn(),
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ });
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "revoked" } }));
    await waitFor(() => expect(screen.getByText(/أُلغيت عضويتك من قِبل قيادة الحملة/)).toBeTruthy());
    expect(sessionStorage.getItem("observatory_team_session")).toBeNull();
  });

  it("does NOT offer the stop control before the native 'started' confirmation (no guessing, P7a)", async () => {
    const startTeamTracking = vi.fn(() => true);
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking,
      stopTeamTracking: vi.fn(),
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ }));
    expect(startTeamTracking).toHaveBeenCalledTimes(1);
    // the panel never GUESSES the service state: startTeamTracking returning
    // true means only "the broadcast was accepted", NOT "the service is live"
    expect(screen.queryByRole("button", { name: /إيقاف التتبع الخلفي/ })).toBeNull();
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "started" } }));
    expect(await screen.findByRole("button", { name: /إيقاف التتبع الخلفي/ })).toBeTruthy();
  });

  it("renders no native tracking card when the bridge is absent (P7b)", async () => {
    seedSession();
    render(<TeamPanel lang="ar" />);
    await waitFor(() => expect(screen.getByText("وحدة بجاية")).toBeTruthy());
    expect(screen.queryByText(/التتبع الخلفي \(خدمة النظام\)/)).toBeNull();
    expect(screen.queryByRole("button", { name: /تشغيل التتبع الخلفي/ })).toBeNull();
  });

  it("resets nativeActive on the native 'error' event and probes for the honest verdict (F2/P1: expired token → join form)", async () => {
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking: vi.fn(),
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ }));
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "started" } }));
    expect(await screen.findByRole("button", { name: /إيقاف التتبع الخلفي/ })).toBeTruthy();

    // the 12h token expires mid-shift: the service dies with "error" and the
    // panel must ask the server immediately (no GPS fix needed for /session)
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/teams/session" ? jsonRes(401, { error: "token expired" }) : jsonRes(404, { error: "no route" })
    );
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "error" } }));

    await waitFor(() => expect(screen.getByLabelText(/رمز الفريق/)).toBeTruthy());
    expect(screen.getByText(/انتهت جلسة الفريق/)).toBeTruthy();
    expect(sessionStorage.getItem("observatory_team_session")).toBeNull();
    // the FGS mirror is off — the panel never shows a green chip over a dead stream
    expect(screen.queryByRole("button", { name: /إيقاف التتبع الخلفي/ })).toBeNull();
  });

  it("keeps the session and resumes the JS loop when the error-probe confirms it alive (F2: transient vs fatal)", async () => {
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking: vi.fn(),
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ }));
    // the FGS takes over: the JS loop is suspended (mutual exclusion)
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "started" } }));
    await screen.findByRole("button", { name: /إيقاف التتبع الخلفي/ });
    fetchMock.mockClear();
    // the service dies with "error" (transport-class failure, not a verdict):
    // the panel resets the mirror and probes — the session is ALIVE
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "error" } }));
    await waitFor(() => expect(screen.getByText(/الجلسة سليمة/)).toBeTruthy());
    // the browser loop RESUMED (nativeActive false + session intact): a beat fires
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]: any[]) => u === "/api/teams/heartbeat")).toBe(true);
    });
    expect(sessionStorage.getItem("observatory_team_session")).not.toBeNull();
  });

  it("adopts the mission carried by native beats and refreshes the last-beat line (F3/P2 + P12)", async () => {
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking: vi.fn(),
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ }));
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "started" } }));
    await screen.findByRole("button", { name: /إيقاف التتبع الخلفي/ });

    // a dispatch lands WHILE the FGS owns the stream: the beat event carries it
    window.dispatchEvent(new CustomEvent("teamTrackingState", {
      detail: { state: "beat", missionJson: '{"sosId":"sos-99","phase":"en_route","since":5000}' },
    }));
    await waitFor(() => expect(screen.getByText(/في الطريق إلى الموقع/)).toBeTruthy());
    expect(screen.getByText(/SOS #/)).toBeTruthy();
    expect(screen.getByText(/آخر نبضة:/)).toBeTruthy();

    // the server clears the mission: a null payload clears the stale card
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "beat" } }));
    await waitFor(() => expect(screen.getByText(/لا توجد مهمة موجهة إليك حالياً/)).toBeTruthy());
  });

  it("ignores a malformed native beat payload instead of crashing (F3/S5 hardening)", async () => {
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking: vi.fn(),
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ }));
    window.dispatchEvent(new CustomEvent("teamTrackingState", {
      detail: { state: "beat", missionJson: "{corrupted json" },
    }));
    await waitFor(() => expect(screen.getByText(/لا توجد مهمة موجهة إليك حالياً/)).toBeTruthy());
  });

  it("asks the bridge for the live FGS state on mount and stays out of the stream (F4/P3 mutual exclusion)", async () => {
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      isTeamTrackingActive: () => true, // FGS already running (panel re-mount scenario)
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking: vi.fn(),
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    // the panel mirrors the asked state immediately — no "started" event needed
    await waitFor(() => expect(screen.getByText(/تتبع خلفي نشط/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /إيقاف التتبع الخلفي/ })).toBeTruthy();
    // and NO JS heartbeats beside the native stream
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.some(([u]: any[]) => u === "/api/teams/heartbeat")).toBe(false);
  });

  it("does not let a stale resume probe wipe a freshly joined session (F5/P4 probe-vs-join race)", async () => {
    let releaseProbe!: (v: unknown) => void;
    const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    let probeCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/teams/session") {
        probeCount += 1;
        if (probeCount === 1) return await probeGate; // the MOUNT probe hangs in flight
        return jsonRes(200, { ...SESSION, mission: null, heartbeatIntervalMs: 15000 });
      }
      if (url === "/api/teams/join") {
        return jsonRes(200, { ...SESSION, token: "tok-2", memberId: "tm-2", mission: null, heartbeatIntervalMs: 15000 });
      }
      return jsonRes(404, { error: "no route" });
    });

    seedSession();
    render(<TeamPanel lang="ar" />);
    // while the mount probe is in flight, the native service reports revocation
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "revoked" } }));
    await waitFor(() => expect(screen.getByLabelText(/رمز الفريق/)).toBeTruthy());
    // the member re-joins with a fresh (valid) code
    fireEvent.change(screen.getByLabelText(/رمز الفريق/), { target: { value: "A2B4C6D8" } });
    fireEvent.change(screen.getByLabelText(/الاسم الظاهر/), { target: { value: "عارة 1" } });
    fireEvent.click(screen.getByRole("button", { name: /انضمام إلى الفريق/ }));
    await waitFor(() => expect(sessionStorage.getItem("observatory_team_session")).not.toBeNull());

    // NOW the stale probe for the OLD session lands with a fatal verdict
    releaseProbe(jsonRes(403, { code: "MEMBER_REVOKED", error: "revoked" }));
    await new Promise((r) => setTimeout(r, 25));
    // the FRESH session survives: no wipe, no burned join code, no false "revoked"
    expect(JSON.parse(sessionStorage.getItem("observatory_team_session") || "{}").token).toBe("tok-2");
    expect(screen.queryByText(/أُلغيت عضويتك من قِبل قيادة الحملة/)).toBeNull();
  });

  it("does not let a stale in-flight heartbeat regress on_scene after the flip (F7/P6 W1 sequencing)", async () => {
    vi.useFakeTimers();
    try {
      let releaseBeat!: (v: unknown) => void;
      const beatGate = new Promise((resolve) => { releaseBeat = resolve; });
      let beatCount = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url === "/api/teams/session") {
          return jsonRes(200, { ...SESSION, mission: { sosId: "sos-77", phase: "en_route", since: 1000 }, heartbeatIntervalMs: 15000 });
        }
        if (url === "/api/teams/heartbeat") {
          beatCount += 1;
          if (beatCount === 1) return jsonRes(200, { ok: true, heartbeatIntervalMs: 15000, mission: { sosId: "sos-77", phase: "en_route", since: 1000 } });
          // the SECOND beat hangs in flight until the flip has landed
          return await beatGate.then(() => jsonRes(200, { ok: true, heartbeatIntervalMs: 15000, mission: { sosId: "sos-77", phase: "en_route", since: 1000 } }));
        }
        if (url === "/api/teams/mission/phase") {
          return jsonRes(200, { ok: true, mission: { sosId: "sos-77", phase: "on_scene", since: 1000 } });
        }
        return jsonRes(404, { error: "no route" });
      });

      seedSession();
      render(<TeamPanel lang="ar" />);
      await vi.advanceTimersByTimeAsync(0); // probe + mount beat resolve → en_route committed
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole("button", { name: /وصلت إلى الموقع/ })).toBeTruthy();

      await vi.advanceTimersByTimeAsync(15_000); // the 15s tick launches beat #2 — it HANGS
      fireEvent.click(screen.getByRole("button", { name: /وصلت إلى الموقع/ }));
      await vi.advanceTimersByTimeAsync(0); // the flip response lands: on_scene committed
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByText(/في موقع الحادث/)).toBeTruthy();

      // NOW the pre-flip heartbeat lands with the OLDER en_route verdict
      releaseBeat(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      // the arrival state survives: no "فشل الوصول" flash on a field screen
      expect(screen.getByText(/في موقع الحادث/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /وصلت إلى الموقع/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the native FGS when the member leaves the team (F6/P5: no orphaned GPS after consent withdrawal)", async () => {
    const stopTeamTracking = vi.fn();
    (globalThis as any).AndroidBridge = {
      isTeamTrackingSupported: () => true,
      startTeamTracking: vi.fn(() => true),
      stopTeamTracking,
    };
    seedSession();
    render(<TeamPanel lang="ar" />);
    fireEvent.click(await screen.findByRole("button", { name: /تشغيل التتبع الخلفي/ }));
    window.dispatchEvent(new CustomEvent("teamTrackingState", { detail: { state: "started" } }));
    await screen.findByRole("button", { name: /إيقاف التتبع الخلفي/ });

    fireEvent.click(screen.getByRole("button", { name: /الانسحاب من الفريق/ }));
    fireEvent.click(await screen.findByRole("button", { name: /نعم، انسحاب/ }));
    await waitFor(() => expect(screen.getByLabelText(/رمز الفريق/)).toBeTruthy());
    expect(sessionStorage.getItem("observatory_team_session")).toBeNull();
    // the orphaned-service window is zero: the FGS is stopped IN the leave path
    expect(stopTeamTracking).toHaveBeenCalledTimes(1);
  });

  it("re-creates the loop when the server re-paces the interval (P7d: heartbeatIntervalMs ≠ 15s)", async () => {
    // /heartbeat always answers 30s: the loop must honor the re-pace by
    // re-creating itself — observable as an immediate re-tick (beat #2) right
    // after beat #1. A loop that ignores the answer stays at exactly 1 beat
    // here (its next would come at the stale 15s cadence).
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/teams/session") return jsonRes(200, { ...SESSION, mission: null, heartbeatIntervalMs: 15000 });
      if (url === "/api/teams/heartbeat") return jsonRes(200, { ok: true, heartbeatIntervalMs: 30000, mission: null });
      return jsonRes(404, { error: "no route" });
    });
    seedSession();
    const beatCalls = () => fetchMock.mock.calls.filter(([u]: any[]) => u === "/api/teams/heartbeat").length;
    render(<TeamPanel lang="ar" />);
    await waitFor(() => expect(beatCalls()).toBe(2));
    // and no leaked 15s timer fires another beat in the window
    await new Promise((r) => setTimeout(r, 300));
    expect(beatCalls()).toBe(2);
  });
});
