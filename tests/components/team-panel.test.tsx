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
});
