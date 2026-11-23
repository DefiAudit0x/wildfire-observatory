// @vitest-environment jsdom
/**
 * Fix 29 (AUTH-1): the staff session is ONE module-level store, not one
 * private copy per hook instance. These specs pin the sharing through the
 * real hook: a refetch from instance A reaches instance B without a timer
 * tick, one fetch per 60 s tick however many instances are mounted, and a
 * late-mounting instance reads the current truth at once.
 *
 * Isolation note: the module resets its cache when the last subscriber
 * leaves, and renderHook auto-cleanup unmounts between tests, so no test
 * leaks state into the next.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useStaffSession } from "../src/hooks/useAuth";
import { useSessionProbe } from "../src/hooks/useSessionProbe";

const commanderSession = {
  user: { role: "commander", unitId: "unit-1", name: "Amina", agentId: "agent-1" },
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
  let sessionStatus = 401;
  let adminOk = true;
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/auth/session")) {
      return Promise.resolve(sessionStatus === 200 ? json(commanderSession, 200) : json({ error: "unauthorized" }, 401));
    }
    if (url.includes("/api/admin/session")) {
      return Promise.resolve(adminOk ? json({ ok: true }, 200) : json({ error: "forbidden" }, 403));
    }
    return Promise.resolve(json({}, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    setSessionStatus: (status: number) => { sessionStatus = status; },
    setAdminOk: (ok: boolean) => { adminOk = ok; },
    authCalls: () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/auth/session")),
    adminCalls: () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/admin/session")),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("staff session — one shared store (Fix 29 AUTH-1)", () => {
  it("a refetch from instance A authenticates instance B without a timer tick", async () => {
    const net = installFetch();
    const a = renderHook(() => useStaffSession());
    const b = renderHook(() => useStaffSession());

    // First probe: 401 — both instances agree they are unauthenticated.
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(a.result.current.session.authenticated).toBe(false);
    expect(b.result.current.session.authenticated).toBe(false);

    // StaffManager logs in: only instance A refetches — B must learn too.
    net.setSessionStatus(200);
    act(() => {
      a.result.current.refetch();
    });
    await waitFor(() => expect(b.result.current.session.authenticated).toBe(true));
    expect(b.result.current.session.role).toBe("commander");
    expect(b.result.current.session.unitId).toBe("unit-1");
    expect(a.result.current.session.role).toBe("commander");
  });

  it("two simultaneous refetches share one in-flight request (review Nit 1)", async () => {
    const net = installFetch();
    net.setSessionStatus(200);
    const a = renderHook(() => useStaffSession());
    const b = renderHook(() => useStaffSession());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    expect(net.authCalls().length).toBe(1);

    // Two refetches in the same tick must dedup through sharedFetch.
    act(() => {
      a.result.current.refetch();
      b.result.current.refetch();
    });
    await waitFor(() => expect(net.authCalls().length).toBe(2));
    expect(a.result.current.session.authenticated).toBe(true);
    expect(b.result.current.session.authenticated).toBe(true);
  });

  it("one /api/auth/session fetch per tick with three instances mounted", async () => {
    vi.useFakeTimers();
    const net = installFetch();
    net.setSessionStatus(200);
    renderHook(() => useStaffSession());
    renderHook(() => useStaffSession());
    renderHook(() => useStaffSession());

    // No waitFor under fake timers (it deadlocks on its own interval) —
    // drive the clock with act + advanceTimersByTimeAsync and assert after
    // each flush. Mounting three instances must still probe only once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(net.authCalls().length).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(net.authCalls().length).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(net.authCalls().length).toBe(3);
  });

  it("an instance mounting after the first probe reads the current session at once", async () => {
    const net = installFetch();
    net.setSessionStatus(200);
    const a = renderHook(() => useStaffSession());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    expect(a.result.current.session.authenticated).toBe(true);

    const b = renderHook(() => useStaffSession());
    // No waiting: the snapshot is read at mount, loading is already false.
    expect(b.result.current.session.authenticated).toBe(true);
    expect(b.result.current.session.role).toBe("commander");
    expect(b.result.current.loading).toBe(false);
  });

  it("useSessionProbe keeps its own admin probe per tick (regression guard)", async () => {
    vi.useFakeTimers();
    const net = installFetch();
    const probe = renderHook(() => useSessionProbe());

    // No waitFor under fake timers — drive the clock and assert after each
    // flush (see the tick test above).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(probe.result.current).toBe(true);
    expect(net.adminCalls().length).toBe(1);
    // No staff subscribers, so no staff fetch rides this timer.
    expect(net.authCalls().length).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(net.adminCalls().length).toBe(2);
    expect(probe.result.current).toBe(true);
    expect(net.authCalls().length).toBe(0);
  });
});
