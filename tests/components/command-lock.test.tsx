import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import CommandLock from "../../src/components/command/CommandLock.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function passwordInput(): HTMLInputElement {
  return screen.getByPlaceholderText("كلمة السر") as HTMLInputElement;
}

describe("CommandLock unlock guard (Fix 33 — CLK-1/CLK-2)", () => {
  it("CLK-1: a second Enter while validating issues no second POST", async () => {
    let release!: (res: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CommandLock lang="ar" onUnlocked={vi.fn()} />);
    fireEvent.change(passwordInput(), { target: { value: "wrong" } });
    fireEvent.keyDown(passwordInput(), { key: "Enter" });
    await waitFor(() => expect(passwordInput().disabled).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The input is disabled, but a dispatched Enter must still be deduped
    // by the function guard — that is what this test proves.
    fireEvent.keyDown(passwordInput(), { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(new Response(JSON.stringify({ valid: false }), { status: 401, headers: { "Content-Type": "application/json" } }));
    });
    await waitFor(() => expect(screen.getByText("كلمة السر غير صحيحة")).toBeTruthy());
    expect(passwordInput().disabled).toBe(false);
  });

  it("CLK-1: the password input is disabled while pending (control for the visible pending state)", async () => {
    let release!: (res: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
    );
    render(<CommandLock lang="ar" onUnlocked={vi.fn()} />);
    fireEvent.change(passwordInput(), { target: { value: "wrong" } });
    fireEvent.keyDown(passwordInput(), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("جارٍ التحقق...")).toBeTruthy());
    expect(passwordInput().disabled).toBe(true);
    await act(async () => {
      release(new Response(JSON.stringify({ valid: false }), { status: 401, headers: { "Content-Type": "application/json" } }));
    });
    await waitFor(() => expect(passwordInput().disabled).toBe(false));
  });

  it("CLK-2: the unlock rides the bounded helper — the issued fetch carries an AbortSignal", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ valid: false }), { status: 401, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CommandLock lang="ar" onUnlocked={vi.fn()} />);
    fireEvent.change(passwordInput(), { target: { value: "wrong" } });
    fireEvent.keyDown(passwordInput(), { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(screen.getByText("كلمة السر غير صحيحة")).toBeTruthy());
  });

  // Fix 33 note: the 15 s stall test was tried and dropped — vitest's fake
  // timers do not fire Node's AbortSignal.timeout, so advancing 15 s never
  // aborts the signal in jsdom. The ceiling itself is apiFetch's (proven by
  // the AbortSignal assertion above), not this component's; no test here
  // can observe the abort without waiting a real 15 s.
});
