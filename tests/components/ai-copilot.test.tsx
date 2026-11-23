// @vitest-environment jsdom
/**
 * Fix 30 (AI-1 + AI-2): the dormant AICopilot's request lifecycle.
 *
 * AI-1: a context change inside the 5 s throttle window used to strand the
 * spinner (the throttled replacement minted an ID, so the aborted
 * predecessor's finally refused to clear `loading`) and skip the load
 * entirely (nothing was scheduled after the window). AI-2: the wilaya
 * selection was the rendered display string, so a language switch left
 * the old-language string in state (and in the request) with no chip
 * highlighted. The component is dormant (no imports anywhere), so these
 * tests mount it directly in jsdom.
 *
 * Timing: fake timers + a frozen clock. `waitFor` deadlocks under fake
 * timers — drive async state with act + advanceTimersByTimeAsync and
 * assert after each flush (Fix 25 lesson). The fetch mock REJECTS with
 * AbortError when its signal aborts, like a real fetch — a mock that
 * ignores the signal would never let the predecessor's finally run, and
 * the spinner test would fail on the fixed code too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import AICopilot from "../../src/components/AICopilot";

const T0 = new Date("2026-11-23T12:00:00Z").getTime();

function deferredResponse() {
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okResponse(guidance: string) {
  return new Response(JSON.stringify({ guidance }), { status: 200 });
}

/** A fetch mock that aborts like a real fetch: the signal's abort rejects. */
function installFetch(
  first: { promise: Promise<Response> } | null,
  guidanceFor: (call: number) => string = () => "guidance-B",
) {
  let calls = 0;
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn((input: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    calls += 1;
    if (init?.body) {
      try {
        bodies.push(JSON.parse(init.body));
      } catch {
        // ignore unparsable bodies
      }
    }
    if (calls === 1 && first) {
      return new Promise<Response>((resolve, reject) => {
        first.promise.then(resolve, reject);
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return Promise.resolve(okResponse(guidanceFor(calls)));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, bodies, calls: () => calls };
}

function refreshButton() {
  return screen.getByTitle("تحديث التقرير") as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("AICopilot request lifecycle (Fix 30 AI-1)", () => {
  it("a context change inside the throttle window does not strand the spinner and the deferred load delivers the new guidance", async () => {
    const first = deferredResponse();
    const net = installFetch(first);
    const coordsA = { lat: 36.7, lng: 3.0 };
    const coordsB = { lat: 36.8, lng: 3.1 };
    const { rerender } = render(<AICopilot mapClickedCoords={coordsA} lang="ar" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(net.calls()).toBe(1);
    expect(refreshButton().disabled).toBe(true);

    // Context change < 5 s later: cleanup aborts #1, the replacement is
    // throttled — but it must NOT mint an ID, so #1's finally still clears
    // the spinner, and the load must be deferred, not dropped.
    rerender(<AICopilot mapClickedCoords={coordsB} lang="ar" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshButton().disabled).toBe(false);
    expect(net.calls()).toBe(1);

    // The deferred load fires after the remaining window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(net.calls()).toBe(2);
    expect(screen.getByText("guidance-B")).toBeTruthy();
    expect(refreshButton().disabled).toBe(false);
  });

  it("a StrictMode double-mount does not strand the spinner", async () => {
    const first = deferredResponse();
    const net = installFetch(first);
    render(
      <StrictMode>
        <AICopilot mapClickedCoords={{ lat: 36.7, lng: 3.0 }} lang="ar" />
      </StrictMode>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Setup 1's request was aborted by cleanup; setup 2's replacement was
    // throttled and deferred. The spinner must clear and the deferred load
    // must deliver the guidance.
    expect(refreshButton().disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(net.calls()).toBe(2);
    expect(screen.getByText("guidance-B")).toBeTruthy();
    expect(refreshButton().disabled).toBe(false);
  });

  it("a completed first answer is replaced by the deferred load for the new context", async () => {
    const net = installFetch(null, (call) => (call === 1 ? "guidance-A" : "guidance-B"));
    const coordsA = { lat: 36.7, lng: 3.0 };
    const coordsB = { lat: 36.8, lng: 3.1 };
    const { rerender } = render(<AICopilot mapClickedCoords={coordsA} lang="ar" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("guidance-A")).toBeTruthy();

    // Context change < 5 s later: throttled — the old answer must not stay
    // under the new context once the window passes.
    rerender(<AICopilot mapClickedCoords={coordsB} lang="ar" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("guidance-A")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(net.calls()).toBe(2);
    expect(screen.queryByText("guidance-A")).toBeNull();
    expect(screen.getByText("guidance-B")).toBeTruthy();
  });
});

describe("AICopilot wilaya identity (Fix 30 AI-2)", () => {
  it("a language switch keeps the selection highlighted and the request carries the current-language name", async () => {
    const net = installFetch(null);
    const { rerender } = render(<AICopilot mapClickedCoords={null} lang="ar" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByText("عنابة"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The Arabic chip is highlighted (code "23" is the identity).
    expect((screen.getByText("عنابة") as HTMLElement).className).toContain("bg-red-600");

    rerender(<AICopilot mapClickedCoords={null} lang="fr" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The same wilaya's French chip is highlighted — no chip unselected.
    expect((screen.getByText("Annaba") as HTMLElement).className).toContain("bg-red-600");
    expect(screen.queryByText("عنابة")).toBeNull();

    // The deferred load fires after the window; its body carries the
    // French display name, not the bare code and not the stale Arabic one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const lastBody = net.bodies[net.bodies.length - 1];
    expect(lastBody.wilaya).toBe("Annaba");
  });

  it("switching language misses the cache and switching back hits it (control)", async () => {
    const net = installFetch(null);
    const { rerender } = render(<AICopilot mapClickedCoords={null} lang="ar" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(net.calls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    rerender(<AICopilot mapClickedCoords={null} lang="fr" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Different lang segment in the key: a fresh fetch, not a cache hit.
    expect(net.calls()).toBe(2);
    expect(net.bodies[1].lang).toBe("fr");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    rerender(<AICopilot mapClickedCoords={null} lang="ar" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Same wilaya + same lang as the first call: the cache answers.
    expect(net.calls()).toBe(2);
  });
});
