// @vitest-environment jsdom
/**
 * Round-8: fetchWithRetry must honour an actual escalating delay on 5xx, and
 * an external abort must cancel the wait INSTANTLY (no zombie timer fires a
 * request after the caller gave up).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchWithRetry } from "../src/utils/api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchWithRetry retry policy", () => {
  it("returns 4xx immediately by contract (a client error is never retried)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("/api/x", {}, 3)).resolves.toHaveProperty("status", 422);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx with an escalating delay, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const promise = fetchWithRetry("/api/x", {}, 3, 1500);
    // first attempt resolved immediately
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // wait #1: 1.5s (after first 503) — still inside the first delay
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // wait #2: 3s (after second 503)
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(promise).resolves.toHaveProperty("status", 200);
    vi.useRealTimers();
  });

  it("an external abort cancels the retry delay immediately (no zombie timer)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const controller = new AbortController();
    const promise = fetchWithRetry("/api/x", { signal: controller.signal }, 3, 60000);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);

    // Even after the full original delay, no further request may fire.
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});