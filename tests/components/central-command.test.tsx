import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import CentralCommand from "../../src/components/CentralCommand";
import type { TrappedSOS } from "../../src/types";
import type { UserLocationData } from "../../src/components/command/StatCards";

// Fix 24 D7: the real CommandMap calls Leaflet's L.map + ResizeObserver in
// an effect, which jsdom does not provide — the render throws and React
// unmounts the whole tree. The sequence logic under test lives in
// CentralCommand, not in the map; SosPanel (unmocked) still renders the
// SOS names the tests assert on.
// Fix 43 (SOS-5): the mocked map records the focus prop it receives, so
// the focus-guard tests can prove a no-fix SOS never sets a focus target.
// Fix 43b: it also records the sosCalls prop, so the dispatch-upsert test
// can prove a re-dispatch response replaces the local entry instead of
// appending a duplicate.
const recordedFocus = vi.hoisted(() => [] as unknown[]);
const recordedSosCalls = vi.hoisted(() => [] as unknown[]);

vi.mock("../../src/components/command/CommandMap", () => ({
  default: (props: { focus?: unknown; sosCalls?: unknown }) => {
    recordedFocus.push(props.focus);
    recordedSosCalls.push(props.sosCalls);
    return null;
  },
}));

/**
 * Fix 24 (CMD-1): the SOS and locations loaders now carry the ARC-W1
 * sequence guard the teams loader already had — only the latest-issued
 * fetch may commit, or a slow response resurrects a just-resolved SOS.
 * The fetch boundary is the global fetch (apiFetch rides it).
 *
 * Timing: real timers throughout. The second fetch round is driven by
 * the visibility-return handler (dispatching `visibilitychange` fires all
 * three fetchers immediately) instead of waiting out the 15 s poll —
 * `vi.useFakeTimers()` does not flush the session probe's promise chain
 * (the probe rides `AbortSignal.timeout`, which the fake-timer clock
 * never advances past), so the panel never unlocks under fake timers.
 */

function sos(id: string, name: string): TrappedSOS {
  return {
    id,
    deviceId: `dev-${id}`,
    lat: 36.75,
    lng: 3.06,
    name,
    status: "active",
    timestamp: new Date().toISOString(),
  };
}

function user(deviceId: string, name: string): UserLocationData {
  return { deviceId, lat: 36.75, lng: 3.06, name, role: "member", lastSeen: new Date().toISOString() };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Fire the visibility-return refresh (all three fetchers) once the first
// round is in flight.
async function fireSecondRound(fetchMock: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]: any[]) => String(u).includes("/api/sos/full"))).toBe(true));
  fireEvent(document, new Event("visibilitychange"));
}

describe("CentralCommand overlapping fetches (Fix 24 / CMD-1)", () => {
  let onRefresh: Mock<() => void>;

  beforeEach(() => {
    onRefresh = vi.fn(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a slow SOS fetch does not overwrite a newer one", async () => {
    let sosCalls = 0;
    let releaseFirst!: (v: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) {
        sosCalls += 1;
        if (sosCalls === 1) return firstGate;
        return jsonResponse(200, [sos("sos-b", "مناداة ب")]);
      }
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await fireSecondRound(fetchMock);
    // The second fetch returns the fresh list.
    await waitFor(() => expect(screen.getByText("مناداة ب")).toBeTruthy());
    // The slow first fetch finally lands with the stale list.
    releaseFirst(jsonResponse(200, [sos("sos-a", "مناداة أ")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("مناداة ب")).toBeTruthy();
    expect(screen.queryByText("مناداة أ")).toBeNull();
  });

  it("a slow SOS fetch does not resurrect a resolved SOS", async () => {
    let sosCalls = 0;
    let releaseFirst!: (v: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    // The second fetch is gated too, on purpose: it must land only AFTER
    // the resolve's local removal, so this test pins the resolve's seq
    // bump in handleResolveSos — without the bump, the second fetch is
    // the latest fetch and its commit would reinstall the resolved SOS.
    let releaseSecond!: (v: Response) => void;
    const secondGate = new Promise<Response>((resolve) => {
      releaseSecond = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) {
        sosCalls += 1;
        if (sosCalls === 1) return firstGate;
        return secondGate;
      }
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/sos-a/resolve") && init?.method === "POST") {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CentralCommand
        reports={[]}
        satellites={[]}
        sosCalls={[sos("sos-a", "مناداة أ")]}
        userLocation={null}
        lang="ar"
        onRefresh={onRefresh}
      />
    );
    await fireSecondRound(fetchMock);
    expect(screen.getByText("مناداة أ")).toBeTruthy();
    // Resolve locally: the panel button, then the dialog's confirm button
    // (both carry the label "تم الإنقاذ" once the dialog opens).
    fireEvent.click(screen.getByText("تم الإنقاذ"));
    expect(screen.getByText("تأكيد الإثبات")).toBeTruthy();
    fireEvent.click(screen.getAllByText("تم الإنقاذ")[1]);
    await waitFor(() => expect(screen.queryByText("مناداة أ")).toBeNull());
    // The second fetch — issued before the resolve — lands after it.
    // Without the resolve's seq bump this reinstalls the SOS; with it,
    // the commit is dropped.
    releaseSecond(jsonResponse(200, [sos("sos-a", "مناداة أ")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("مناداة أ")).toBeNull();
    // The slow first fetch lands with the pre-resolve list.
    releaseFirst(jsonResponse(200, [sos("sos-a", "مناداة أ")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("مناداة أ")).toBeNull();
  });

  it("a slow locations fetch does not overwrite a newer one or re-trigger the parent refresh", async () => {
    let locCalls = 0;
    let releaseFirst!: (v: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, []);
      if (String(url).includes("/api/locations")) {
        locCalls += 1;
        if (locCalls === 1) return firstGate;
        return jsonResponse(200, [user("u-new", "جديد")]);
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await fireSecondRound(fetchMock);
    await waitFor(() => expect(screen.getByText("جديد")).toBeTruthy());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    releaseFirst(jsonResponse(200, [user("u-old", "قديم")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("جديد")).toBeTruthy();
    expect(screen.queryByText("قديم")).toBeNull();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("a single fetch still commits (control)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, [sos("sos-a", "مناداة أ")]);
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await waitFor(() => expect(screen.getByText("مناداة أ")).toBeTruthy());
  });
});

// --- Fix 32 (CMD-2 / CMD-3) ---

describe("CentralCommand manual refresh and resolve (Fix 32 / CMD-2, CMD-3)", () => {
  let onRefresh: Mock<() => void>;

  beforeEach(() => {
    onRefresh = vi.fn(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function baseFetchMock(overrides: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const hit = overrides(String(url), init);
      if (hit) return hit;
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, []);
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
  }

  function countCalls(fetchMock: ReturnType<typeof vi.fn>, needle: string) {
    return fetchMock.mock.calls.filter(([u]: any[]) => String(u).includes(needle)).length;
  }

  it("CMD-2: manual Refresh calls all three loaders", async () => {
    const fetchMock = baseFetchMock(() => null);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    // Wait for the panel to unlock and the first round to land.
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]: any[]) => String(u).includes("/api/locations"))).toBe(true));
    const before = {
      sos: countCalls(fetchMock, "/api/sos/full"),
      teams: countCalls(fetchMock, "/api/teams"),
      loc: countCalls(fetchMock, "/api/locations"),
    };
    fireEvent.click(screen.getByRole("button", { name: "تحديث" }));
    await waitFor(() => expect(countCalls(fetchMock, "/api/sos/full")).toBeGreaterThan(before.sos));
    expect(countCalls(fetchMock, "/api/teams")).toBeGreaterThan(before.teams);
    expect(countCalls(fetchMock, "/api/locations")).toBeGreaterThan(before.loc);
  });

  it("CMD-2: the button still triggers the parent refresh exactly once (control)", async () => {
    const fetchMock = baseFetchMock(() => null);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "تحديث" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
  });

  it("CMD-3: double-confirm issues one POST and the dialog stays open while pending", async () => {
    let releaseResolve!: (v: Response) => void;
    const resolveGate = new Promise<Response>((resolve) => {
      releaseResolve = resolve;
    });
    const fetchMock = baseFetchMock((url, init) => {
      if (url.includes("/api/sos/full")) return jsonResponse(200, [sos("sos-a", "مناداة أ")]);
      if (url.includes("/api/sos/sos-a/resolve") && init?.method === "POST") return resolveGate;
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand
        reports={[]}
        satellites={[]}
        sosCalls={[sos("sos-a", "مناداة أ")]}
        userLocation={null}
        lang="ar"
        onRefresh={onRefresh}
      />
    );
    await waitFor(() => expect(screen.getByText("مناداة أ")).toBeTruthy());
    fireEvent.click(screen.getByText("تم الإنقاذ"));
    expect(screen.getByText("تأكيد الإثبات")).toBeTruthy();
    const confirmButton = screen.getAllByText("تم الإنقاذ")[1].closest("button")!;
    fireEvent.click(confirmButton);
    // While the request is pending the dialog stays open and confirm is disabled.
    await waitFor(() => expect(confirmButton).toBeDisabled());
    expect(screen.getByText("تأكيد الإثبات")).toBeTruthy();
    // A second confirm attempt issues no second POST.
    fireEvent.click(confirmButton);
    await new Promise((r) => setTimeout(r, 50));
    expect(countCalls(fetchMock, "/api/sos/sos-a/resolve")).toBe(1);
    // The resolve lands: dialog closes, SOS removed, success toast shown.
    releaseResolve(jsonResponse(200, { ok: true }));
    await waitFor(() => expect(screen.queryByText("تأكيد الإثبات")).toBeNull());
    expect(screen.queryByText("مناداة أ")).toBeNull();
    expect(screen.getByText(/تم إثبات النجدة/)).toBeTruthy();
  });

  it("CMD-3: a failed resolve keeps the dialog open for retry", async () => {
    let resolveCalls = 0;
    const fetchMock = baseFetchMock((url, init) => {
      if (url.includes("/api/sos/full")) return jsonResponse(200, [sos("sos-a", "مناداة أ")]);
      if (url.includes("/api/sos/sos-a/resolve") && init?.method === "POST") {
        resolveCalls += 1;
        return jsonResponse(500, {});
      }
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand
        reports={[]}
        satellites={[]}
        sosCalls={[sos("sos-a", "مناداة أ")]}
        userLocation={null}
        lang="ar"
        onRefresh={onRefresh}
      />
    );
    await waitFor(() => expect(screen.getByText("مناداة أ")).toBeTruthy());
    fireEvent.click(screen.getByText("تم الإنقاذ"));
    fireEvent.click(screen.getAllByText("تم الإنقاذ")[1]);
    await waitFor(() => expect(screen.getByText(/فشل حل الاستغاثة/)).toBeTruthy());
    expect(screen.getByText("تأكيد الإثبات")).toBeTruthy();
    expect(screen.getByText("مناداة أ")).toBeTruthy();
    // Retry in place: a second confirm issues a second POST.
    fireEvent.click(screen.getAllByText("تم الإنقاذ")[1]);
    await waitFor(() => expect(resolveCalls).toBe(2));
  });

  it("CMD-3: the resolve rides the bounded helper (carries an AbortSignal)", async () => {
    const fetchMock = baseFetchMock((url, init) => {
      if (url.includes("/api/sos/full")) return jsonResponse(200, [sos("sos-a", "مناداة أ")]);
      if (url.includes("/api/sos/sos-a/resolve") && init?.method === "POST") return jsonResponse(200, { ok: true });
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand
        reports={[]}
        satellites={[]}
        sosCalls={[sos("sos-a", "مناداة أ")]}
        userLocation={null}
        lang="ar"
        onRefresh={onRefresh}
      />
    );
    await waitFor(() => expect(screen.getByText("مناداة أ")).toBeTruthy());
    fireEvent.click(screen.getByText("تم الإنقاذ"));
    fireEvent.click(screen.getAllByText("تم الإنقاذ")[1]);
    await waitFor(() => expect(screen.queryByText("مناداة أ")).toBeNull());
    const resolveCall = fetchMock.mock.calls.find(([u]: any[]) => String(u).includes("/api/sos/sos-a/resolve"));
    expect(resolveCall).toBeTruthy();
    expect((resolveCall![1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("CMD-3 (32b Minor 2): a landing resolve does not close another SOS's dialog", async () => {
    let releaseResolve!: (v: Response) => void;
    const resolveGate = new Promise<Response>((resolve) => {
      releaseResolve = resolve;
    });
    const fetchMock = baseFetchMock((url, init) => {
      if (url.includes("/api/sos/full")) return jsonResponse(200, [sos("sos-a", "مناداة أ"), sos("sos-b", "مناداة ب")]);
      if (url.includes("/api/sos/sos-a/resolve") && init?.method === "POST") return resolveGate;
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand
        reports={[]}
        satellites={[]}
        sosCalls={[sos("sos-a", "مناداة أ"), sos("sos-b", "مناداة ب")]}
        userLocation={null}
        lang="ar"
        onRefresh={onRefresh}
      />
    );
    await waitFor(() => expect(screen.getByText("مناداة ب")).toBeTruthy());
    // Open A's dialog and confirm (the resolve is gated).
    fireEvent.click(screen.getAllByText("تم الإنقاذ")[0]);
    expect(screen.getByText("تأكيد الإثبات")).toBeTruthy();
    fireEvent.click(screen.getAllByText("تم الإنقاذ")[2]);
    // Cancel A's dialog and open B's instead.
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    expect(screen.queryByText("تأكيد الإثبات")).toBeNull();
    fireEvent.click(screen.getAllByText("تم الإنقاذ")[1]);
    expect(screen.getByText("تأكيد الإثبات")).toBeTruthy();
    // A's resolve lands: A's row is removed, but B's dialog must stay open.
    releaseResolve(jsonResponse(200, { ok: true }));
    await waitFor(() => expect(screen.queryByText("مناداة أ")).toBeNull());
    expect(screen.getByText("تأكيد الإثبات")).toBeTruthy();
    expect(screen.getByText("مناداة ب")).toBeTruthy();
  });
});

describe("CentralCommand SOS focus (Fix 43 — SOS-5)", () => {
  let onRefresh: Mock<() => void>;

  beforeEach(() => {
    onRefresh = vi.fn(() => {});
    recordedFocus.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function focusFetchMock(sosList: TrappedSOS[]) {
    return vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, []);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, sosList);
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
  }

  it("clicking focus on a no-fix SOS sets no focus target", async () => {
    const noFix: TrappedSOS = {
      id: "sos-nofix",
      deviceId: "dev-nofix",
      lat: null,
      lng: null,
      hasLocation: false,
      name: "مناداة بلا موقع",
      status: "active",
      timestamp: new Date().toISOString(),
    };
    vi.stubGlobal("fetch", focusFetchMock([noFix]));
    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await waitFor(() => expect(screen.getByText("مناداة بلا موقع")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "تحديد" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(recordedFocus.every((f) => f == null)).toBe(true);
  });

  it("clicking focus on a located SOS focuses its coordinates (control)", async () => {
    vi.stubGlobal("fetch", focusFetchMock([sos("sos-loc", "مناداة بموقع")]));
    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await waitFor(() => expect(screen.getByText("مناداة بموقع")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "تحديد" }));
    await waitFor(() =>
      expect(recordedFocus.some((f: any) => f && f.lat === 36.75 && f.lng === 3.06)).toBe(true)
    );
  });
});

describe("CentralCommand dispatch upsert (Fix 43b)", () => {
  let onRefresh: Mock<() => void>;

  beforeEach(() => {
    onRefresh = vi.fn(() => {});
    recordedFocus.length = 0;
    recordedSosCalls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a re-dispatch response replaces the local entry instead of appending a duplicate", async () => {
    const dispatched = {
      teamId: "team-alpha",
      type: "protection_civile" as const,
      teamNameAr: "فريق ألفا",
      teamNameFr: "Team Alpha",
      dispatchedAt: "2026-11-24T10:00:00.000Z",
      status: "en_route" as const,
      notes: "",
    };
    const already: TrappedSOS = {
      ...sos("sos-upsert-1", "مناداة موجهة"),
      dispatchedTeams: [dispatched],
    };
    const team = { teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true, baseLat: null, baseLng: null, blockedPrincipals: [], members: [], activeMission: null };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, [team]);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, [already]);
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes("/dispatch")) {
        // Fix 43c: a real replay returns the STORED entry verbatim — the
        // same dispatchedAt as the local entry (the local copy is stale on
        // notes only). The 43b draft used 11:00 here, which no real replay
        // ever produces; with identity-based reconciliation (43c) a
        // mismatched dispatchedAt would append instead of replacing.
        return jsonResponse(200, {
          success: true,
          dispatch: { ...dispatched, notes: "second" },
          alreadyDispatched: true,
        });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await waitFor(() => expect(screen.getByText("مناداة موجهة")).toBeTruthy());
    // Open the dispatch form and re-dispatch the same team. (Two selects
    // exist on the page — RegisteredTeams' always-rendered team-type
    // select plus this SOS form's team picker — so pick the one that
    // offers team-alpha.)
    fireEvent.click(screen.getByRole("button", { name: "توجيه نجدة للمحاصر" }));
    const dispatchSelect = screen
      .getAllByRole("combobox")
      .find((s) => s.querySelector('option[value="team-alpha"]'));
    expect(dispatchSelect).toBeTruthy();
    fireEvent.change(dispatchSelect!, { target: { value: "team-alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الفرقة" }));
    // The local entry must be REPLACED by the response dispatch (notes
    // "second") — on old code the response is appended, so the first entry
    // keeps notes "" and the list grows to 2.
    await waitFor(() => {
      const last = recordedSosCalls[recordedSosCalls.length - 1] as TrappedSOS[];
      const target = (last || []).find((s) => s.id === "sos-upsert-1");
      expect(target?.dispatchedTeams?.[0]?.notes).toBe("second");
    });
    const last = recordedSosCalls[recordedSosCalls.length - 1] as TrappedSOS[];
    const target = (last || []).find((s) => s.id === "sos-upsert-1");
    expect(target?.dispatchedTeams).toHaveLength(1);
  });
});

describe("CentralCommand dispatch identity upsert (Fix 43c)", () => {
  let onRefresh: Mock<() => void>;

  beforeEach(() => {
    onRefresh = vi.fn(() => {});
    recordedFocus.length = 0;
    recordedSosCalls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const teamAlpha = { teamId: "team-alpha", type: "protection_civile", name: "Team Alpha", nameAr: "فريق ألفا", active: true, baseLat: null, baseLng: null, blockedPrincipals: [], members: [], activeMission: null };

  const driveDispatchForm = () => {
    fireEvent.click(screen.getByRole("button", { name: "توجيه نجدة للمحاصر" }));
    const dispatchSelect = screen
      .getAllByRole("combobox")
      .find((s) => s.querySelector('option[value="team-alpha"]'));
    expect(dispatchSelect).toBeTruthy();
    fireEvent.change(dispatchSelect!, { target: { value: "team-alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الفرقة" }));
  };

  const lastTarget = (sosId: string) => {
    const last = recordedSosCalls[recordedSosCalls.length - 1] as TrappedSOS[];
    return (last || []).find((s) => s.id === sosId);
  };

  it("a fresh dispatch after clear appends instead of replacing the earlier dispatch", async () => {
    const first = {
      teamId: "team-alpha",
      type: "protection_civile" as const,
      teamNameAr: "فريق ألفا",
      teamNameFr: "Team Alpha",
      dispatchedAt: "2026-11-24T10:00:00.000Z",
      status: "en_route" as const,
      notes: "first",
    };
    const already: TrappedSOS = {
      ...sos("sos-fresh-1", "مناداة موجهة"),
      dispatchedTeams: [first],
    };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, [teamAlpha]);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, [already]);
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes("/dispatch")) {
        return jsonResponse(200, {
          success: true,
          dispatch: { ...first, dispatchedAt: "2026-11-24T11:00:00.000Z", notes: "second" },
          alreadyDispatched: false,
        });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await waitFor(() => expect(screen.getByText("مناداة موجهة")).toBeTruthy());
    driveDispatchForm();
    // The server now holds TWO entries for the same team (clear +
    // re-dispatch). The 43b teamId-only replace collapsed them to [D2];
    // the fresh dispatch must APPEND, keeping D1 ("first") intact.
    await waitFor(() => {
      expect(lastTarget("sos-fresh-1")?.dispatchedTeams).toHaveLength(2);
    });
    const target = lastTarget("sos-fresh-1");
    expect(target?.dispatchedTeams?.[0]?.notes).toBe("first");
    expect(target?.dispatchedTeams?.[1]?.notes).toBe("second");
  });

  it("a replay of an already-held dispatch replaces only its own entry", async () => {
    const first = {
      teamId: "team-alpha",
      type: "protection_civile" as const,
      teamNameAr: "فريق ألفا",
      teamNameFr: "Team Alpha",
      dispatchedAt: "2026-11-24T10:00:00.000Z",
      status: "en_route" as const,
      notes: "first",
    };
    const second = {
      ...first,
      dispatchedAt: "2026-11-24T11:00:00.000Z",
      notes: "second",
    };
    const already: TrappedSOS = {
      ...sos("sos-replay-1", "مناداة موجهة"),
      dispatchedTeams: [first, second],
    };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("/api/admin/session")) return jsonResponse(200, {});
      if (String(url).includes("/api/teams")) return jsonResponse(200, [teamAlpha]);
      if (String(url).includes("/api/sos/full")) return jsonResponse(200, [already]);
      if (String(url).includes("/api/locations")) return jsonResponse(200, []);
      if (String(url).includes("/dispatch")) {
        // A real replay returns the stored D2 verbatim.
        return jsonResponse(200, {
          success: true,
          dispatch: { ...second },
          alreadyDispatched: true,
        });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CentralCommand reports={[]} satellites={[]} sosCalls={[]} userLocation={null} lang="ar" onRefresh={onRefresh} />
    );
    await waitFor(() => expect(screen.getByText("مناداة موجهة")).toBeTruthy());
    driveDispatchForm();
    // Wait until the dispatch POST was issued, then flush the response
    // chain — a waitFor on the final state would exit immediately here,
    // because the pre-dispatch state already satisfies it ([D1, D2]).
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/dispatch"))).toBe(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The 43b teamId-only replace overwrote BOTH entries with D2, so a
    // ["second","second"] state was rendered; a later poll can restore
    // [D1, D2], so the corruption must be caught in the recorded history,
    // not only in the final state.
    const histories = (recordedSosCalls as TrappedSOS[][]).map((list) =>
      (list || [])
        .filter((s) => s.id === "sos-replay-1")
        .map((s) => (s.dispatchedTeams || []).map((t) => t.notes))
    );
    expect(histories.flat().some((notes) => notes.length === 2 && notes[0] === "second" && notes[1] === "second")).toBe(false);
    const target = lastTarget("sos-replay-1");
    expect(target?.dispatchedTeams).toHaveLength(2);
    expect(target?.dispatchedTeams?.[0]?.notes).toBe("first");
    expect(target?.dispatchedTeams?.[1]?.notes).toBe("second");
  });
});
