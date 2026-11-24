import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../worker/firms-proxy.js";

const ENV = { PROXY_SECRET: "test-secret", NASA_FIRMS_KEY: "dummy" };

function authedRequest(path: string) {
  return new Request(`https://worker.test${path}`, {
    headers: { Authorization: "Bearer test-secret" },
  });
}

describe("firms proxy bbox validation (Fix 47 — FPROXY-1)", () => {
  let capturedUrl = "";
  let fetchCalls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    fetchCalls++;
    capturedUrl = String(url);
    return new Response("latitude,longitude\n1,2\n", {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    });
  });

  beforeEach(() => {
    capturedUrl = "";
    fetchCalls = 0;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("rejects an empty first coordinate and never calls upstream", async () => {
    const res = await worker.fetch(authedRequest("/VIIRS_SNPP_NRT/,20,10,30/1"), ENV);
    expect(res.status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  it("rejects an empty second coordinate and never calls upstream", async () => {
    const res = await worker.fetch(authedRequest("/VIIRS_SNPP_NRT/5,,20,30/1"), ENV);
    expect(res.status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  it("normalizes a non-canonical valid bbox in the upstream path", async () => {
    const res = await worker.fetch(authedRequest("/VIIRS_SNPP_NRT/20.0,10,30,40/1"), ENV);
    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(1);
    expect(capturedUrl.endsWith("/VIIRS_SNPP_NRT/20,10,30,40/1")).toBe(true);
  });

  it("passes a canonical valid bbox through unchanged (control)", async () => {
    const res = await worker.fetch(authedRequest("/VIIRS_SNPP_NRT/-17,18,20,38/1"), ENV);
    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(1);
    expect(capturedUrl.endsWith("/VIIRS_SNPP_NRT/-17,18,20,38/1")).toBe(true);
  });
});
