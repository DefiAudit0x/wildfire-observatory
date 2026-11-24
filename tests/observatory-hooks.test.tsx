// @vitest-environment jsdom
/**
 * ARC-H4: the useObservatoryData god-hook (775 lines, ~9 fused concerns) is
 * decomposed into src/hooks/observatory/. These specs pin the DECOMPOSED
 * behavior through the same public orchestrator surface App.tsx consumes:
 *
 *   - poll: five parallel dataset commits, per-dataset failure isolation,
 *     schema gate, superseded-cycle suppression
 *   - mesh: gossip admission (validate-BEFORE-hash), dedupe, consensus
 *     protocol guard, status/node-count + mesh:online broadcast
 *   - submission: JSON + multipart paths, image-drop honesty, transport-vs-
 *     rejection mesh fan-out semantics (4xx never relays, 5xx/transport does)
 *   - confirmation: 401 → enroll → retry, error codes, protocol validation
 *   - broadcast purity: coordinate bounds gate + PII allow-list
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useObservatoryData, buildLocalPendingReport } from "../src/hooks/useObservatoryData";
import { buildMultipartForm } from "../src/hooks/observatory/observatoryUpload";
import { broadcastReportToMesh } from "../src/hooks/observatory/observatoryMeshBroadcast";
import { meshClient } from "../src/lib/mesh";
import { broadcastMessage, checkAndRecordMessageHash } from "../src/utils/meshBridge";

vi.mock("../src/lib/mesh", () => {
  const statusHandlers = new Set<(s: any, c: number) => void>();
  const messageHandlers = new Set<(m: any) => void>();
  return {
    meshClient: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onStatus: (h: (s: any, c: number) => void) => {
        statusHandlers.add(h);
        return () => statusHandlers.delete(h);
      },
      onMessage: (h: (m: any) => void) => {
        messageHandlers.add(h);
        return () => messageHandlers.delete(h);
      },
      emitStatus: (s: any, c: number) => statusHandlers.forEach((h) => h(s, c)),
      emitMessage: (m: any) => messageHandlers.forEach((h) => h(m)),
    },
  };
});

vi.mock("../src/utils/live", () => ({ useLiveEvents: vi.fn() }));

vi.mock("../src/utils/meshBridge", () => ({
  broadcastMessage: vi.fn(),
  isMeshSupported: vi.fn(() => true),
  checkAndRecordMessageHash: vi.fn(() => true),
}));

// ---- Valid wire samples (mirror the datasetValidators contracts) ----------
const validReport = (id = "rep-1", overrides: Record<string, unknown> = {}) => ({
  id, lat: 36.75, lng: 5.06, locationName: "Tizi Ouzou", wilaya: "الجزائر",
  description: "Smoke column rising over the ridge", severity: "high",
  status: "pending", timestamp: new Date().toISOString(), consensusCount: 1,
  ...overrides,
});
const validSatellite = () => ({
  id: "sat-1", lat: 36.7, lng: 5.1, brightness: 320, confidence: 90,
  scanTime: new Date().toISOString(), satellite: "VIIRS", wilaya: "الجزائر",
});
const validWilaya = () => ({
  nameAr: "الجزائر", nameFr: "Alger", activeFires: 0, satelliteHotspots: 1,
  severity: "low", evacuationRecommended: false, emergencyPhone: "14",
});
const validSos = (id = "sos-1", overrides: Record<string, unknown> = {}) => ({
  id, lat: 36.7, lng: 5.05, status: "active", timestamp: new Date().toISOString(), ...overrides,
});
const validNotification = () => ({
  id: "not-1", deviceId: "dev-1", titleAr: "عنوان", titleFr: "Titre",
  bodyAr: "نص", bodyFr: "Corps", type: "info", timestamp: new Date().toISOString(), read: false,
});

// ---- Fetch router ----------------------------------------------------------
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

type Router = (url: string, init?: RequestInit) => Promise<Response> | Response;

function installFetch(router: Router) {
  // Real fetch REJECTS on network failure (never throws synchronously) — the
  // deferred router call keeps that contract so poll/commit settle normally.
  const fetchMock = vi.fn((input: any, init?: RequestInit) =>
    Promise.resolve().then(() => router(String(input instanceof Request ? input.url : input), init)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const fullRouter = (overrides: Partial<Record<"reports" | "satellites" | "wilayas" | "sos" | "notifications", unknown>> = {}, status = 200): Router => {
  return (url: string) => {
    if (url.includes("/api/reports")) return json(overrides.reports ?? [validReport()], status);
    if (url.includes("/api/satellite-data")) return json(overrides.satellites ?? [validSatellite()], status);
    if (url.includes("/api/wilayas")) return json(overrides.wilayas ?? [validWilaya()], status);
    if (url.includes("/api/sos")) return json(overrides.sos ?? [validSos()], status);
    if (url.includes("/api/notifications/")) return json(overrides.notifications ?? [validNotification()], status);
    return json({}, 404);
  };
};

const emitMessage = (m: any) => act(() => { (meshClient as any).emitMessage(m); });
const emitStatus = (s: any, c: number) => act(() => { (meshClient as any).emitStatus(s, c); });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  const rendered = renderHook(() => useObservatoryData());
  await act(async () => {}); // flush the mount-time poll IIFE
  return rendered;
}

describe("observatory poll — dataset commits and failure isolation", () => {
  it("commits all five datasets in parallel and reports a full refresh", async () => {
    installFetch(fullRouter());
    const { result } = await mount();

    await waitFor(() => expect(result.current.reports).toHaveLength(1));
    expect(result.current.satellites).toHaveLength(1);
    expect(result.current.wilayas).toHaveLength(1);
    expect(result.current.sosCalls).toHaveLength(1);
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.loading).toBe(false);

    let outcome = await act(() => result.current.fetchData());
    expect(outcome.allOk).toBe(true);
    expect(outcome.anyOk).toBe(true);
    expect(Object.values(result.current.datasetHealth).every((h) => h.lastAttemptOk)).toBe(true);
    expect(result.current.lastRefreshed).toBeGreaterThan(0);
    expect(result.current.lastBackendContact).toBeGreaterThan(0);
  });

  it("a failing dataset preserves its prior state and marks only itself dead", async () => {
    installFetch(fullRouter());
    const { result } = await mount();
    await waitFor(() => expect(result.current.reports).toHaveLength(1));

    // Second round: SOS endpoint dies, everything else still answers.
    installFetch((url: string) =>
      url.includes("/api/sos") ? json({ error: "down" }, 500) : fullRouter()(url));
    await act(async () => {
      const outcome = await result.current.fetchData();
      expect(outcome.allOk).toBe(false);
      expect(outcome.anyOk).toBe(true); // the other four datasets still answer
    });

    expect(result.current.sosCalls).toHaveLength(1); // preserved, never wiped
    expect(result.current.datasetHealth.sos.lastAttemptOk).toBe(false);
    expect(result.current.datasetHealth.sos.lastFailureReason).toBe("http");
    expect(result.current.datasetHealth.reports.lastAttemptOk).toBe(true);
  });

  it("a schema-invalid payload fails its dataset only (schema reason)", async () => {
    installFetch(fullRouter({ reports: [{ totally: "malformed" }] }));
    const { result } = await mount();

    await waitFor(() => expect(result.current.reports).toHaveLength(0));
    expect(result.current.datasetHealth.reports.lastFailureReason).toBe("schema");
    expect(result.current.satellites).toHaveLength(1);
  });

  it("a superseded cycle never writes state (older response cannot overwrite fresher data)", async () => {
    let reportsRequests = 0;
    let releaseCycleOne!: (r: Response) => void;
    const heldCycleOne = new Promise<Response>((resolve) => { releaseCycleOne = resolve; });

    installFetch((url: string) => {
      if (url.includes("/api/reports")) {
        reportsRequests += 1;
        if (reportsRequests === 1) return heldCycleOne; // mount cycle hangs
        return json([validReport("rep-new")]);
      }
      if (url.includes("/api/satellite-data")) return json([validSatellite()]);
      if (url.includes("/api/wilayas")) return json([validWilaya()]);
      if (url.includes("/api/sos")) return json([validSos()]);
      if (url.includes("/api/notifications/")) return json([validNotification()]);
      return json({}, 404);
    });

    const { result } = renderHook(() => useObservatoryData());
    await act(async () => {}); // mount cycle (1) is parked on the deferred

    await act(async () => { await result.current.fetchData(); }); // cycle 2 wins
    expect(result.current.reports.map((r) => r.id)).toEqual(["rep-new"]);

    // The stale cycle's payload arrives LAST — it must not overwrite.
    await act(async () => { releaseCycleOne(json([validReport("rep-old")])); });
    expect(result.current.reports.map((r) => r.id)).toEqual(["rep-new"]);
  });

  it("recovers from a lost enrollment response: a 403 DEVICE_MISMATCH re-enrolls and retries with the bound id", async () => {
    // Fix 3b: the enroll POST can succeed server-side (Set-Cookie bound to a
    // new web_ id) while its response never reaches this browser — the next
    // read then answers 403 DEVICE_MISMATCH, and the client used to stay
    // stuck there forever because enrollment only triggered on 401.
    const BOUND_ID = "web_0123456789abcdef0123456789abcdef0123";
    let notificationsGets = 0;
    const fetchMock = installFetch((url: string, init?: RequestInit) => {
      if (url.includes("/api/notifications/enroll")) {
        expect(init?.method).toBe("POST");
        return json({ ok: true, deviceId: BOUND_ID });
      }
      if (url.includes("/api/notifications/")) {
        notificationsGets += 1;
        if (notificationsGets === 1) {
          return json(
            { error: "Device identity mismatch. Clear site data (cookies) to bind a new device.", code: "DEVICE_MISMATCH" },
            403
          );
        }
        return json([validNotification()]);
      }
      return fullRouter()(url);
    });
    const { result } = await mount();

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    const calls = fetchMock.mock.calls.map((c: any) => String(c[0]));
    expect(calls.some((u) => u.includes("/api/notifications/enroll"))).toBe(true);
    expect(calls.some((u) => u.includes(`/api/notifications/${BOUND_ID}`))).toBe(true);
    expect(result.current.datasetHealth.notifications.lastAttemptOk).toBe(true);
  });

  it("the recovery enrollment is not aborted by a superseding poll cycle", async () => {
    // Fix 3b: the enrollment POST used to ride the cycle signal, so a newer
    // cycle starting mid-enrollment aborted it — the exact way the response
    // gets lost. The recovery enrollment must survive a cycle superseding it.
    const BOUND_ID = "web_0123456789abcdef0123456789abcdef0123";
    const pendingEnrolls: Array<(r: Response) => void> = [];
    let enrollSignal: AbortSignal | null = null;
    let notificationsGets = 0;
    installFetch((url: string, init?: RequestInit) => {
      if (url.includes("/api/notifications/enroll")) {
        if (!enrollSignal) enrollSignal = (init?.signal ?? null) as AbortSignal | null;
        return new Promise<Response>((resolve) => { pendingEnrolls.push(resolve); });
      }
      if (url.includes("/api/notifications/")) {
        notificationsGets += 1;
        if (notificationsGets <= 2) {
          return json({ error: "Device identity mismatch.", code: "DEVICE_MISMATCH" }, 403);
        }
        return json([validNotification()]);
      }
      return fullRouter()(url);
    });
    const { result } = await mount();
    await waitFor(() => expect(enrollSignal).not.toBeNull());

    // Cycle 2 starts while cycle 1's enrollment is still held: cycle 1's
    // controller is aborted, but the untied enrollment must not be.
    let cycle2: Promise<unknown> | undefined;
    await act(async () => { cycle2 = result.current.fetchData(); });
    expect(enrollSignal!.aborted).toBe(false);

    await act(async () => {
      pendingEnrolls.splice(0).forEach((resolve) => resolve(json({ ok: true, deviceId: BOUND_ID })));
      await cycle2;
    });
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
  });

  it("two overlapping enrollment cycles share a single enroll POST", async () => {
    // Fix 3c: untying enrollment from the cycle signal (Fix 3b) left a new
    // race — each cycle fired its own POST /enroll, minting a second server
    // id that could disagree with the cookie the browser kept. Overlapping
    // cycles must share one pending enrollment.
    const BOUND_ID = "web_0123456789abcdef0123456789abcdef0123";
    let releaseEnroll!: (r: Response) => void;
    const heldEnroll = new Promise<Response>((resolve) => { releaseEnroll = resolve; });
    let notificationsGets = 0;
    const fetchMock = installFetch((url: string) => {
      if (url.includes("/api/notifications/enroll")) return heldEnroll;
      if (url.includes("/api/notifications/")) {
        notificationsGets += 1;
        if (notificationsGets <= 2) {
          return json({ error: "Device enrollment required", code: "DEVICE_ENROLLMENT_REQUIRED" }, 401);
        }
        return json([validNotification()]);
      }
      return fullRouter()(url);
    });
    const enrollCalls = () =>
      fetchMock.mock.calls.filter((c: any) => String(c[0]).includes("/api/notifications/enroll"));
    const { result } = await mount();
    await waitFor(() => expect(enrollCalls()).toHaveLength(1));

    // Cycle 2 starts while cycle 1's enrollment is still in flight: it must
    // reuse the pending enrollment, not fire a second POST /enroll.
    let cycle2: Promise<unknown> | undefined;
    await act(async () => { cycle2 = result.current.fetchData(); });
    await waitFor(() => expect(notificationsGets).toBe(2));
    expect(enrollCalls()).toHaveLength(1);

    await act(async () => {
      releaseEnroll(json({ ok: true, deviceId: BOUND_ID }));
      await cycle2;
    });
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    // Both cycles retried the read with the same adopted id — and the
    // server-device-id event refreshes the poll with it once more, so the
    // count is 2 plus that refresh.
    const boundGets = fetchMock.mock.calls.filter((c: any) =>
      String(c[0]).includes(`/api/notifications/${BOUND_ID}`)
    );
    expect(boundGets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(boundGets.map((c: any) => String(c[0]))).size).toBe(1);
  });
});

// Fix 29 (POLL-1): StrictMode replays the mount effect (setup → cleanup →
// setup). The old cleanup-only effect left mountedRef false after the
// replay, so every later dataset/health/spinner write was discarded while
// the poll kept fetching — the feed looked alive and was dead. The control
// pins that the replay, not the hook generally, is what the test exercises.
//
// NOTE: this MUST use renderHook's reactStrictMode option. A wrapper
// component that renders <StrictMode> does NOT double-invoke effects in
// this suite (probed 2026-11-23: setups=1 via wrapper, setups=2 via the
// option) — a wrapper-based StrictMode test passes vacuously on old code.
describe("observatory poll — StrictMode replay (Fix 29 POLL-1)", () => {
  it("commits all five datasets and clears loading after a StrictMode replay", async () => {
    installFetch(fullRouter());
    const { result } = renderHook(() => useObservatoryData(), { reactStrictMode: true });
    await act(async () => {});

    await waitFor(() => expect(result.current.reports).toHaveLength(1));
    expect(result.current.satellites).toHaveLength(1);
    expect(result.current.wilayas).toHaveLength(1);
    expect(result.current.sosCalls).toHaveLength(1);
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.lastBackendContact).toBeGreaterThan(0);
    expect(result.current.lastRefreshed).toBeGreaterThan(0);
  });

  it("commits all five datasets without StrictMode (control)", async () => {
    installFetch(fullRouter());
    const { result } = await mount();

    await waitFor(() => expect(result.current.reports).toHaveLength(1));
    expect(result.current.loading).toBe(false);
    expect(result.current.lastBackendContact).toBeGreaterThan(0);
  });
});

describe("mesh sync — gossip admission and consensus protocol", () => {
  it("admits a valid gossip report and dedupes by report id — forced honest pending + mesh origin (v2.15.0)", async () => {
    installFetch(fullRouter());
    const { result } = await mount();

    emitMessage({ type: "report:new", report: validReport("rep-mesh"), ts: 1, lat: 36.7, lng: 5.05 });
    await waitFor(() => expect(result.current.reports.map((r) => r.id)).toContain("rep-mesh"));

    emitMessage({ type: "report:new", report: validReport("rep-mesh"), ts: 2, lat: 36.7, lng: 5.05 });
    expect(result.current.reports.filter((r) => r.id === "rep-mesh")).toHaveLength(1);

    // Mesh peers may gossip EXISTENCE, never trust: even a frame claiming
    // verified/999 is admitted honestly as pending with a mesh origin mark.
    const admitted = result.current.reports.find((r) => r.id === "rep-mesh") as unknown as Record<string, unknown>;
    expect(admitted.status).toBe("pending");
    expect(admitted.origin).toBe("mesh");
  });

  it("validates the report BEFORE recording the gossip hash (audit B10) and rejects garbage", async () => {
    installFetch(fullRouter());
    await mount();

    emitMessage({ type: "report:new", report: { id: "evil", severity: "nuclear" }, ts: 1 });
    expect(checkAndRecordMessageHash).not.toHaveBeenCalled();
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it("applies consensus ONLY from hub-authoritative confirms — node-relayed values ignored (v2.15.0)", async () => {
    installFetch(fullRouter());
    const { result } = await mount();
    await waitFor(() => expect(result.current.reports).toHaveLength(1));
    const id = result.current.reports[0].id;

    // Node-relayed frame (carries `from`): attacker-controlled trust values
    // must be ignored entirely — the next poll reconciles the truth.
    emitMessage({ type: "report:confirm", id, status: "verified", consensusCount: 999999, from: "evil-node" });
    expect(result.current.reports.find((r) => r.id === id)?.status).not.toBe("verified");

    // Hub-authoritative frame (no `from`): a real ledger confirmation.
    emitMessage({ type: "report:confirm", id, status: "verified", consensusCount: 3 });
    await waitFor(() => {
      const updated = result.current.reports.find((r) => r.id === id);
      expect(updated?.status).toBe("verified");
      expect(updated?.consensusCount).toBe(3);
    });

    emitMessage({ type: "report:confirm", id, status: "verified", consensusCount: 2.5 });
    emitMessage({ type: "report:confirm", id, status: "nuclear", consensusCount: 4 });
    expect(result.current.reports.find((r) => r.id === id)?.consensusCount).toBe(3);
  });

  it("tracks mesh status/node count and announces mesh:online exactly on connect", async () => {
    installFetch(fullRouter());
    const { result } = await mount();
    const onlineSpy = vi.fn();
    window.addEventListener("mesh:online", onlineSpy);

    emitStatus("online", 7);
    expect(result.current.meshStatus).toBe("online");
    expect(result.current.meshNodeCount).toBe(7);
    expect(onlineSpy).toHaveBeenCalledTimes(1);

    emitStatus("online", 9);
    // Parity with the original hook: every online status re-announces
    // (downstream listeners like ReportForm's mesh:online handler are
    // idempotent), so a second announcement is correct behavior.
    expect(onlineSpy).toHaveBeenCalledTimes(2);
    window.removeEventListener("mesh:online", onlineSpy);
  });
});

describe("report submission — transport vs rejection semantics", () => {
  const payload = {
    lat: 36.75, lng: 5.06, locationName: "Tizi Ouzou", wilaya: "الجزائر",
    description: "Smoke column rising over the ridge", severity: "high" as const,
    reporterPhone: "0555000111",
  };

  it("submits via JSON, admits the server copy, fans the SERVER copy out to mesh", async () => {
    const fetchMock = installFetch((url: string, init?: RequestInit) => {
      if (url.includes("/api/reports")) {
        // GET returns the list (including the just-committed POST report —
        // the server is authoritative); POST returns the single normalized copy.
        return init?.method === "POST"
          ? json(validReport("rep-post"))
          : json([validReport(), validReport("rep-post")]);
      }
      if (url.includes("/api/satellite-data")) return json([validSatellite()]);
      if (url.includes("/api/wilayas")) return json([validWilaya()]);
      if (url.includes("/api/sos")) return json([validSos()]);
      if (url.includes("/api/notifications/")) return json([validNotification()]);
      return json({}, 404);
    });
    const { result } = await mount();

    let response!: any;
    await act(async () => {
      response = await result.current.handleCreateReport(payload);
    });
    expect(response.responseValid).toBe(true);
    expect(response.id).toBe("rep-post");
    expect(result.current.reports.some((r) => r.id === "rep-post")).toBe(true);

    const post = fetchMock.mock.calls.find(([, opts]: any) => opts?.method === "POST" && !(opts?.body instanceof FormData));
    expect(post).toBeDefined();
    const [, postInit] = post as unknown as [string, any];
    expect(JSON.parse(postInit.body as string).reporterPhone).toBe("0555000111"); // PII to the SERVER, never to mesh
    const meshJson = JSON.parse(vi.mocked(broadcastMessage).mock.calls[0][0]);
    expect(meshJson.reporterPhone).toBeUndefined();
    expect(meshJson.reporterName).toBeUndefined();
  });

  it("a TRANSPORT failure fans the (PII-free) pending shape out to mesh and rethrows", async () => {
    installFetch((url: string) => {
      if (url.includes("/api/reports")) throw new Error("network down");
      return json([]);
    });
    const { result } = await mount();

    await expect(result.current.handleCreateReport(payload)).rejects.toThrow("network down");
    expect(broadcastMessage).toHaveBeenCalledTimes(1);
    const [meshJson, type, lat, lng] = vi.mocked(broadcastMessage).mock.calls[0];
    const parsed = JSON.parse(meshJson);
    expect(type).toBe("report");
    expect(parsed.reporterPhone).toBeUndefined();
    expect(parsed.status).toBe("pending");
    expect(lat).toBeCloseTo(36.75);
    expect(lng).toBeCloseTo(5.06);
  });

  it("a 4xx REJECTION never relays (the server read it and refused)", async () => {
    installFetch((url: string) => (url.includes("/api/reports") ? json({ error: "Validation failed" }, 422) : json([])));
    const { result } = await mount();

    let thrown: any;
    await act(async () => {
      try { await result.current.handleCreateReport(payload); } catch (e) { thrown = e; }
    });
    expect(thrown).toBeDefined();
    expect(thrown.data.error).toBe("Validation failed");
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it("a 5xx failure relays to mesh (an online peer may commit it)", async () => {
    installFetch((url: string) => (url.includes("/api/reports") ? json({ error: "down" }, 500) : json([])));
    const { result } = await mount();

    await expect(result.current.handleCreateReport(payload)).rejects.toThrow("down");
    expect(broadcastMessage).toHaveBeenCalledTimes(1);
  });

  it("submits images via multipart and honestly reports a dropped photo", async () => {
    const goodImage = "data:image/jpeg;base64," + btoa("fakebytes");
    const fetchMock = installFetch((url: string) => {
      if (url.startsWith("data:image/")) return new Response("bytes", { headers: { "Content-Type": "image/jpeg" } });
      if (url.includes("/api/reports")) return json(validReport("rep-img"));
      return json([]);
    });
    const { result } = await mount();

    let response!: any;
    await act(async () => {
      response = await result.current.handleCreateReport({ ...payload, image: goodImage });
    });
    expect(response.responseValid).toBe(true);
    expect(response.imageNotAttached).toBeUndefined();
    const multipartPost = fetchMock.mock.calls.find(([, opts]: any) => opts?.body instanceof FormData);
    expect(multipartPost).toBeDefined();
    const [, multipartInit] = multipartPost as unknown as [string, any];
    expect((multipartInit.body as FormData).get("deviceId")).toBe(result.current.deviceId);

    // Corrupt data URL + old-WebView fetch refusal → report still travels, photo honestly reported dropped.
    installFetch((url: string) => {
      if (url.startsWith("data:image/")) throw new Error("data urls refused");
      if (url.includes("/api/reports")) return json(validReport("rep-img2"));
      return json([]);
    });
    await act(async () => {
      response = await result.current.handleCreateReport({ ...payload, image: "data:image/jpeg;base64,!!!!not-base64!!!!" });
    });
    expect(response.responseValid).toBe(true);
    expect(response.imageNotAttached).toBe(true);
  });

  it("a malformed SUCCESS response returns accepted-but-syncing (never fabricated state)", async () => {
    installFetch((url: string) => (url.includes("/api/reports") ? json({ id: "x" }) /* not a report */ : json([])));
    const { result } = await mount();

    let response!: any;
    await act(async () => {
      response = await result.current.handleCreateReport(payload);
    });
    expect(response).toMatchObject({ submissionAccepted: true, responseValid: false, syncRequired: true });
    expect(response.clientGeneratedId).toBeDefined();
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it("a stalled success body aborts at the 15 s ceiling and returns accepted-but-syncing (Fix 39 — RSUB-1)", async () => {
    let bodyReject: ((e: unknown) => void) | null = null;
    installFetch((url: string, init?: RequestInit) => {
      if (url.includes("/api/reports") && init?.method === "POST") {
        const bodyPromise = new Promise((_resolve, reject) => {
          bodyReject = reject;
        });
        init.signal?.addEventListener(
          "abort",
          () => bodyReject?.(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
        return { ok: true, status: 200, json: () => bodyPromise } as unknown as Response;
      }
      return json([]);
    });
    const { result } = await mount();
    vi.useFakeTimers();
    try {
      let response!: any;
      const promise = act(async () => {
        response = await result.current.handleCreateReport(payload);
      });
      await vi.advanceTimersByTimeAsync(15000);
      await promise;
      expect(response).toMatchObject({ submissionAccepted: true, responseValid: false, syncRequired: true });
      expect(response.clientGeneratedId).toBeDefined();
      expect(broadcastMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unparseable SUCCESS body returns accepted-but-syncing (Fix 39 — RSUB-2)", async () => {
    installFetch((url: string, init?: RequestInit) => {
      if (url.includes("/api/reports") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        } as unknown as Response;
      }
      return json([]);
    });
    const { result } = await mount();

    let response!: any;
    await act(async () => {
      response = await result.current.handleCreateReport(payload);
    });
    expect(response).toMatchObject({ submissionAccepted: true, responseValid: false, syncRequired: true });
    expect(response.clientGeneratedId).toBeDefined();
    expect(broadcastMessage).not.toHaveBeenCalled();
  });
});

describe("report confirmation — principal enrollment and error codes", () => {
  it("enrolls the public principal on 401 and retries the confirm", async () => {
    const fetchMock = installFetch((url: string) => {
      if (url.includes("/confirm")) return json({ status: "verified", consensusCount: 2 }, 401); // first attempt
      if (url.includes("/api/public-principal")) return json({}, 200);
      return json([]);
    });
    // Second confirm attempt must succeed: flip the router after enrollment.
    let enrolled = false;
    fetchMock.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/confirm")) {
        if (!enrolled) return json({ error: "Public principal required" }, 401);
        return json({ status: "verified", consensusCount: 2 });
      }
      if (u.includes("/api/public-principal")) { enrolled = true; return json({}); }
      return json([]);
    });

    const { result } = await mount();
    let ok = false;
    await act(async () => { ok = await result.current.handleConfirmReport("rep-1"); });
    expect(ok).toBe(true);
    const calls = fetchMock.mock.calls.map((c: any) => String(c[0]));
    expect(calls.filter((u: string) => u.includes("/confirm")).length).toBe(2);
    expect(calls.some((u: string) => u.includes("/api/public-principal"))).toBe(true);
    expect(result.current.confirmError).toBeNull();
  });

  it("surfaces bounded server messages instead of failing silently", async () => {
    installFetch((url: string) => (url.includes("/confirm") ? json({ error: "RATE_LIMITED" }, 429) : json([])));
    const { result } = await mount();

    let ok = true;
    await act(async () => { ok = await result.current.handleConfirmReport("rep-1"); });
    expect(ok).toBe(false);
    expect(result.current.confirmError).toBe("RATE_LIMITED");
    act(() => { result.current.clearConfirmError(); });
    expect(result.current.confirmError).toBeNull();
  });

  it("maps an abort to CONFIRMATION_TIMEOUT", async () => {
    installFetch(() => { const e = new DOMException("aborted", "AbortError"); throw e; });
    const { result } = await mount();

    let ok = true;
    await act(async () => { ok = await result.current.handleConfirmReport("rep-1"); });
    expect(ok).toBe(false);
    expect(result.current.confirmError).toBe("CONFIRMATION_TIMEOUT");
  });

  it("rejects an out-of-protocol confirmation response (INVALID_CONFIRMATION_RESPONSE)", async () => {
    installFetch((url: string) => (url.includes("/confirm") ? json({ status: "nuclear", consensusCount: 1 }) : json([])));
    const { result } = await mount();

    let ok = true;
    await act(async () => { ok = await result.current.handleConfirmReport("rep-1"); });
    expect(ok).toBe(false);
    expect(result.current.confirmError).toBe("INVALID_CONFIRMATION_RESPONSE");
  });
});

describe("mesh broadcast purity — bounds gate and PII allow-list", () => {
  it("never broadcasts coordinates outside physical bounds", () => {
    broadcastReportToMesh({ lat: 999, lng: 5 });
    broadcastReportToMesh({ lat: Number.NaN, lng: 5 });
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it("strips PII fields from the server copy before broadcast", () => {
    broadcastReportToMesh({ ...validReport("rep-b"), reporterPhone: "0555", image: "data:x" } as any);
    expect(broadcastMessage).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(vi.mocked(broadcastMessage).mock.calls[0][0]);
    expect(parsed.reporterPhone).toBeUndefined();
    expect(parsed.image).toBeUndefined();
    expect(parsed.id).toBe("rep-b");
  });

  it("buildLocalPendingReport NaN-guards coordinates (never a silent (0,0))", () => {
    const report = buildLocalPendingReport({ lat: "abc", lng: "def", locationName: "X", wilaya: "Y", description: "Z" });
    expect(Number.isNaN(report.lat)).toBe(true);
    expect(Number.isNaN(report.lng)).toBe(true);
  });
});

describe("multipart form builder — direct unit pin", () => {
  it("decodes a data URL into an image part and appends deviceId", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bytes", { headers: { "Content-Type": "image/jpeg" } })));
    const { fd, imageDropped } = await buildMultipartForm(
      { lat: 1, lng: 2, locationName: "X", wilaya: "Y", description: "Z", image: "data:image/jpeg;base64,AAAA" },
      "dev-9"
    );
    expect(imageDropped).toBe(false);
    expect(fd.get("deviceId")).toBe("dev-9");
    expect((fd.get("image") as File).name).toMatch(/^report-\d+\.jpg$/);
  });
});

  it("an empty data URL is dropped, not attached as a zero-byte image (Fix 39 — UPL-1, fetch path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { headers: { "Content-Type": "image/jpeg" } })));
    const { fd, imageDropped } = await buildMultipartForm(
      { lat: 1, lng: 2, locationName: "X", wilaya: "Y", description: "Z", image: "data:image/jpeg;base64," },
      "dev-9"
    );
    expect(imageDropped).toBe(true);
    expect(fd.get("image")).toBeNull();
  });

  it("an empty data URL is dropped on the atob fallback too (Fix 39 — UPL-1)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("data URLs refused"); }));
    const { fd, imageDropped } = await buildMultipartForm(
      { lat: 1, lng: 2, locationName: "X", wilaya: "Y", description: "Z", image: "data:image/jpeg;base64," },
      "dev-9"
    );
    expect(imageDropped).toBe(true);
    expect(fd.get("image")).toBeNull();
  });


describe("Fix 12e partial satellite admission", () => {
  it.each([false, true])("applies validated partial 503 data (empty=%s), keeps degraded health, and clears partial on recovery", async (empty) => {
    const data = empty ? [] : [validSatellite()];
    installFetch((url) => url.includes("/api/satellite-data") ? json({ hotspots: data }, 503) : fullRouter()(url));
    const { result } = await mount();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.satellites).toEqual(data);
    expect(result.current.satellitesPartial).toBe(true);
    expect(result.current.datasetHealth.satellites).toMatchObject({ lastSuccess: null, lastAttemptOk: false, lastFailureReason: "http" });
    expect(result.current.lastRefreshed).toBe(0);
    installFetch(fullRouter());
    await act(() => result.current.fetchData());
    expect(result.current.satellitesPartial).toBe(false);
    expect(result.current.datasetHealth.satellites.lastAttemptOk).toBe(true);
  });

  it.each([{}, { hotspots: null }, { hotspots: [{ id: "bad" }] }, { hotspots: "bad" }])("preserves prior partial data on an invalid/absent 503 payload %j", async (body) => {
    installFetch((url) => url.includes("/api/satellite-data") ? json({ hotspots: [validSatellite()] }, 503) : fullRouter()(url));
    const { result } = await mount();
    await waitFor(() => expect(result.current.satellitesPartial).toBe(true));
    const prior = result.current.satellites;
    installFetch((url) => url.includes("/api/satellite-data") ? json(body, 503) : fullRouter()(url));
    await act(() => result.current.fetchData());
    expect(result.current.satellites).toEqual(prior);
    expect(result.current.satellitesPartial).toBe(true);
    expect(result.current.datasetHealth.satellites.lastFailureReason).toBe("http");
  });
});
