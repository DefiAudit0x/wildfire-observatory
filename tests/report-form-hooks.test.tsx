// @vitest-environment jsdom
/**
 * ARC-H13: the 1905-line ReportForm god-component is decomposed into
 * src/hooks/reportForm/ (5 hooks + 2 pure modules + a thin orchestrator).
 * These specs pin the DECOMPOSED semantics that were previously locked
 * inside one component body:
 *
 *   - shared pure contract: bearing math, cardinal directions, loaded-draft
 *     normalization, server-message extraction, accuracy clamping
 *   - camera correlation: 15km/45° FOV gate, freshness gate, 40-95% estimate
 *   - image pipeline: captured-image application, reset, edge-AI pre-scan
 *     (success + honest-failure branch + superseded-capture hardening)
 *   - offline drafts: load normalization, automatic sync on connectivity
 *     return, acceptance-gated removal, retry accounting, durable-failure
 *     honesty
 *   - submit: validation copy, offline intercept (transport never called),
 *     server-verified-only badge activation, error mapping, idempotency key
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  calculateBearing,
  extractServerErrorMessage,
  getBearingDirection,
  getDistanceKm,
  normalizeLoadedDraft,
  normalizeSubmissionResult,
  safeAlignmentAccuracyValue,
} from "../src/hooks/reportForm/reportFormShared";
import { useReportCamera } from "../src/hooks/reportForm/useReportCamera";
import { useReportImage } from "../src/hooks/reportForm/useReportImage";
import { useOfflineDraftQueue } from "../src/hooks/reportForm/useOfflineDraftQueue";
import { useReportSubmit } from "../src/hooks/reportForm/useReportSubmit";

vi.mock("../src/utils/offlineDraftStore", () => ({
  loadOfflineDrafts: vi.fn(),
  replaceOfflineDrafts: vi.fn(),
  removeOfflineDrafts: vi.fn(),
}));

vi.mock("../src/utils/badgeStore", () => ({
  setReporterBadge: vi.fn(),
}));

import {
  loadOfflineDrafts,
  replaceOfflineDrafts,
  removeOfflineDrafts,
} from "../src/utils/offlineDraftStore";
import { setReporterBadge } from "../src/utils/badgeStore";

const noop = () => undefined;

// ---- Shared pure contract ---------------------------------------------------

describe("reportFormShared pure contract", () => {
  it("computes compass bearings across the four quadrants", () => {
    expect(Math.round(calculateBearing(0, 0, 10, 0))).toBe(0);   // due north
    expect(Math.round(calculateBearing(0, 0, 0, 10))).toBe(90);  // due east
    expect(Math.round(calculateBearing(10, 0, 0, 0))).toBe(180); // due south
    expect(Math.round(calculateBearing(0, 10, 0, 0))).toBe(270); // due west
  });

  it("measures great-circle distance in km", () => {
    // ~1 degree of latitude ≈ 111.2 km
    expect(getDistanceKm(36, 5, 37, 5)).toBeGreaterThan(110);
    expect(getDistanceKm(36, 5, 36, 5)).toBe(0);
  });

  it("maps angles to localized cardinal directions with wrap-around", () => {
    expect(getBearingDirection(0, false)).toBe("N");
    expect(getBearingDirection(46, false)).toBe("NE");
    expect(getBearingDirection(92, false)).toBe("E");
    expect(getBearingDirection(370, false)).toBe("N");
    expect(getBearingDirection(90, true)).toBe("شرق");
    expect(getBearingDirection(0, true)).toBe("شمال");
  });

  it("normalizes drafts read back from the durable store", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const sparse = normalizeLoadedDraft({ id: "d1", timestamp: "2025-12-31T23:00:00.000Z" } as Record<string, unknown>, now);
    expect(sparse.schemaVersion).toBe(1);
    expect(sparse.createdAt).toBe("2025-12-31T23:00:00.000Z");
    expect(sparse.queuedAt).toBe("2025-12-31T23:00:00.000Z");
    expect(sparse.retryCount).toBe(0);

    const rich = normalizeLoadedDraft({
      id: "d2", schemaVersion: 2, createdAt: "c", queuedAt: "q", retryCount: Number.NaN,
    } as Record<string, unknown>, now);
    expect(rich.schemaVersion).toBe(2);
    expect(rich.createdAt).toBe("c");
    expect(rich.queuedAt).toBe("q");
    expect(rich.retryCount).toBe(0); // NaN is not finite → explicit zero
  });

  it("extracts the server message from both axios-like and raw shapes", () => {
    expect(extractServerErrorMessage({ data: { error: "raw" } })).toBe("raw");
    expect(extractServerErrorMessage({ response: { data: { error: "wrapped" } } })).toBe("wrapped");
    expect(extractServerErrorMessage(new Error("nope"))).toBeUndefined();
    expect(extractServerErrorMessage("string error")).toBeUndefined();
    expect(extractServerErrorMessage(undefined)).toBeUndefined();
  });

  it("clamps the alignment gauge into an honest 0-100 range", () => {
    expect(safeAlignmentAccuracyValue(null)).toBe(0);
    expect(safeAlignmentAccuracyValue(150)).toBe(100);
    expect(safeAlignmentAccuracyValue(-5)).toBe(0);
    expect(safeAlignmentAccuracyValue(88)).toBe(88);
  });

  // Fix 28 (RFSH-1): the validator must accept every status the server
  // contract accepts — a durable replay of a moderator-resolved/rejected
  // report returns its stored status, and narrowing it to pending/verified
  // made the offline sync loop throw and wedge at the oldest draft.
  it("accepts a durable replay of a moderator-resolved report", () => {
    const result = normalizeSubmissionResult({ responseValid: true, id: "rep-old", status: "resolved" });
    expect(result.responseValid).toBe(true);
    expect(result.status).toBe("resolved");
    expect(result.id).toBe("rep-old");
  });

  it("accepts a durable replay of a moderator-rejected report", () => {
    const result = normalizeSubmissionResult({ responseValid: true, id: "rep-old", status: "rejected" });
    expect(result.responseValid).toBe(true);
    expect(result.status).toBe("rejected");
  });

  it("keeps the pending/verified contract and the malformed-shape rejections (control)", () => {
    expect(normalizeSubmissionResult({ responseValid: true, id: "rep-1", status: "pending" }).responseValid).toBe(true);
    expect(normalizeSubmissionResult({ responseValid: true, id: "rep-1", status: "verified" }).responseValid).toBe(true);
    expect(normalizeSubmissionResult({ responseValid: true, id: "rep-1", status: "resolved" }).status).toBe("resolved");
    // Malformed shapes stay invalid.
    expect(normalizeSubmissionResult({ responseValid: true, status: "pending" }).responseValid).toBe(false);
    expect(normalizeSubmissionResult({ responseValid: true, id: "ab", status: "pending" }).responseValid).toBe(false);
    expect(normalizeSubmissionResult({ responseValid: true, id: "rep-1", status: "bogus" }).responseValid).toBe(false);
    expect(normalizeSubmissionResult("not an object").responseValid).toBe(false);
    // An offline draft is still accepted via the offline branch.
    expect(normalizeSubmissionResult({ responseValid: true, isOfflineDraft: true }).responseValid).toBe(true);
  });
});

// ---- Camera correlation ------------------------------------------------------

const freshReport = (overrides: Record<string, unknown> = {}) => ({
  id: "rep-east",
  status: "pending",
  timestamp: new Date().toISOString(),
  lat: 36.75,
  lng: 5.06 + 0.05, // ≈ 4.5 km due east of the observer
  locationName: "East ridge",
  ...overrides,
});

describe("useReportCamera correlation", () => {
  it("matches a fresh report within the 15km/45° FOV gate and scores it 40-95%", () => {
    // Hoisted: the hook (like the original component) trusts stable props —
    // a new array/object per render would re-fire the correlation effect.
    const reports = [freshReport()];
    const { result } = renderHook(() =>
      useReportCamera({ lat: "36.75", lng: "5.06", reports, isArabic: true, setErrorMsg: noop })
    );
    act(() => result.current.setManualHeading(90)); // facing due east
    expect(result.current.matchedReport?.id).toBe("rep-east");
    expect(result.current.alignmentAccuracy).toBeGreaterThanOrEqual(40);
    expect(result.current.alignmentAccuracy).toBeLessThanOrEqual(95);
    expect(result.current.headingSource).toBe("manual");
  });

  it("refuses a report outside the bearing gate even when it is close", () => {
    const reports = [freshReport()];
    const { result } = renderHook(() =>
      useReportCamera({ lat: "36.75", lng: "5.06", reports, isArabic: true, setErrorMsg: noop })
    );
    act(() => result.current.setManualHeading(0)); // facing north, report is east
    expect(result.current.matchedReport).toBeNull();
    expect(result.current.alignmentAccuracy).toBeNull();
  });

  it("refuses stale reports regardless of alignment", () => {
    const reports = [freshReport({ timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })];
    const { result } = renderHook(() =>
      useReportCamera({ lat: "36.75", lng: "5.06", reports, isArabic: true, setErrorMsg: noop })
    );
    act(() => result.current.setManualHeading(90));
    expect(result.current.matchedReport).toBeNull();
  });

  it("stops the camera and clears orientation state", () => {
    const { result } = renderHook(() =>
      useReportCamera({ lat: "36.75", lng: "5.06", reports: [], isArabic: true, setErrorMsg: noop })
    );
    act(() => {
      result.current.setManualHeading(45);
      result.current.setManualPitch(-10);
      result.current.setShowCalibrationGuide(true);
    });
    act(() => result.current.stopCamera());
    expect(result.current.heading).toBeNull();
    expect(result.current.pitch).toBeNull();
    expect(result.current.headingSource).toBe("none");
    expect(result.current.pitchSource).toBe("none");
    expect(result.current.showCalibrationGuide).toBe(false);
    expect(result.current.isCameraOpen).toBe(false);
  });
});

// ---- Camera lifecycle (Fix 28 RCAM-1) ---------------------------------------
// jsdom has no navigator.mediaDevices — each test stubs getUserMedia with a
// deferred promise. window.DeviceOrientationEvent is undefined in jsdom, so
// the DOE block is skipped and the tests exercise the getUserMedia await only.

function deferredCamera<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeCameraStream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], track };
}

function stubGetUserMedia(mock: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: mock },
    configurable: true,
  });
}

function renderCameraHook() {
  return renderHook(() =>
    useReportCamera({ lat: "36.75", lng: "5.06", reports: [], isArabic: true, setErrorMsg: noop }),
  );
}

describe("useReportCamera lifecycle", () => {
  afterEach(() => {
    // The mediaDevices stub is defined per test (configurable) — remove it
    // so no later test in this file can see a stale getUserMedia.
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  it("a stream granted after Close is stopped at once and never stored", async () => {
    const gate = deferredCamera<unknown>();
    const getUserMediaMock = vi.fn().mockReturnValue(gate.promise);
    stubGetUserMedia(getUserMediaMock);
    const stream = fakeCameraStream();
    const { result } = renderCameraHook();
    await act(async () => {
      void result.current.startCamera();
    });
    expect(result.current.isCameraOpen).toBe(true);
    expect(result.current.cameraStatus).toBe("closed"); // pending
    act(() => result.current.stopCamera());
    await act(async () => {
      gate.resolve(stream);
    });
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBeNull();
    expect(result.current.cameraStatus).toBe("closed"); // not "active"
  });

  it("a stream granted after unmount is stopped at once", async () => {
    const gate = deferredCamera<unknown>();
    const getUserMediaMock = vi.fn().mockReturnValue(gate.promise);
    stubGetUserMedia(getUserMediaMock);
    const stream = fakeCameraStream();
    const { result, unmount } = renderCameraHook();
    await act(async () => {
      void result.current.startCamera();
    });
    unmount();
    await act(async () => {
      gate.resolve(stream);
    });
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
  });

  it("a grant while mounted still activates the camera (control)", async () => {
    const getUserMediaMock = vi.fn();
    stubGetUserMedia(getUserMediaMock);
    const stream = fakeCameraStream();
    getUserMediaMock.mockResolvedValue(stream);
    const { result } = renderCameraHook();
    await act(async () => {
      await result.current.startCamera();
    });
    expect(result.current.stream).toBe(stream);
    expect(result.current.cameraStatus).toBe("active");
    act(() => result.current.stopCamera());
    // stopCamera stops the tracks AND the [stream] cleanup re-runs on the
    // null assignment and stops them again (pre-existing double stop) —
    // the control pins only that the track IS stopped and the state clears.
    expect(stream.track.stop).toHaveBeenCalled();
    expect(result.current.stream).toBeNull();
  });

  it("the camera button works again after a Close-during-permission (not bricked)", async () => {
    const gate = deferredCamera<unknown>();
    const getUserMediaMock = vi.fn().mockReturnValue(gate.promise);
    stubGetUserMedia(getUserMediaMock);
    const stream = fakeCameraStream();
    const { result } = renderCameraHook();
    await act(async () => {
      void result.current.startCamera();
    });
    act(() => result.current.stopCamera());
    await act(async () => {
      gate.resolve(stream);
    });
    expect(result.current.stream).toBeNull();
    // Second tap with a fresh pending grant must NOT early-return.
    const gate2 = deferredCamera<unknown>();
    getUserMediaMock.mockReturnValue(gate2.promise);
    await act(async () => {
      void result.current.startCamera();
    });
    expect(result.current.isCameraOpen).toBe(true);
  });

  // Fix 28b (CodeRabbit Minor, watch 1 on PR #159): stopCamera must release
  // the start guard too — a retry tapped while the first permission prompt
  // is still pending hit the guard and returned silently (no camera, no
  // message). The first grant is still an orphan and gets stopped.
  it("a retry tapped while the first prompt is still pending starts a fresh request", async () => {
    const gate1 = deferredCamera<unknown>();
    const gate2 = deferredCamera<unknown>();
    const getUserMediaMock = vi.fn().mockReturnValue(gate1.promise);
    stubGetUserMedia(getUserMediaMock);
    const stream1 = fakeCameraStream();
    const stream2 = fakeCameraStream();
    const { result } = renderCameraHook();
    await act(async () => {
      void result.current.startCamera();
    });
    act(() => result.current.stopCamera());
    // Retry BEFORE the first grant resolves — the window the old code
    // swallowed at the start guard.
    getUserMediaMock.mockReturnValue(gate2.promise);
    await act(async () => {
      void result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      gate1.resolve(stream1);
    });
    expect(stream1.track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBeNull();
    await act(async () => {
      gate2.resolve(stream2);
    });
    expect(result.current.stream).toBe(stream2);
    expect(result.current.cameraStatus).toBe("active");
  });

  // Fix 28c (CodeRabbit Minor, watch 2 on PR #159): only the live request
  // may release the start guard — a stale completion (request A, invalidated
  // by Close) must not clear the guard of the retry B that started after
  // it, or a third tap would start request C and invalidate B.
  it("a stale completion does not clear the retry's guard", async () => {
    const gate1 = deferredCamera<unknown>();
    const gate2 = deferredCamera<unknown>();
    const getUserMediaMock = vi.fn().mockReturnValue(gate1.promise);
    stubGetUserMedia(getUserMediaMock);
    const stream1 = fakeCameraStream();
    const stream2 = fakeCameraStream();
    const { result } = renderCameraHook();
    // Request A, then Close, then retry B while A is still pending.
    await act(async () => {
      void result.current.startCamera();
    });
    act(() => result.current.stopCamera());
    getUserMediaMock.mockReturnValue(gate2.promise);
    await act(async () => {
      void result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    // A completes as an orphan — its finally must NOT release B's guard.
    await act(async () => {
      gate1.resolve(stream1);
    });
    expect(stream1.track.stop).toHaveBeenCalledTimes(1);
    // Third tap while B is still pending must hit the guard, not start C.
    await act(async () => {
      void result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    // B completes normally and owns the camera.
    await act(async () => {
      gate2.resolve(stream2);
    });
    expect(result.current.stream).toBe(stream2);
    expect(result.current.cameraStatus).toBe("active");
  });
});

// ---- Image pipeline ----------------------------------------------------------

type PixelFill = [number, number, number];
let canvasFill: PixelFill = [10, 10, 10];
const liveImages: Array<{ onload: (() => void) | null }> = [];

beforeEach(() => {
  canvasFill = [10, 10, 10];
  liveImages.length = 0;
  vi.mocked(setReporterBadge).mockClear(); // mock state must not leak across tests

  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 100;
    height = 100;
    set src(value: string) {
      // Load is NOT automatic: tests trigger onloads in a chosen order to
      // prove the superseded-capture hardening.
      liveImages.push(this);
    }
    get src() {
      return "";
    }
  }
  vi.stubGlobal("Image", FakeImage);

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((type: string) => {
    if (type !== "2d") return null;
    return {
      drawImage: noop,
      getImageData: () => {
        const data = new Uint8ClampedArray(50 * 50 * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = canvasFill[0];
          data[i + 1] = canvasFill[1];
          data[i + 2] = canvasFill[2];
          data[i + 3] = 255;
        }
        return { data, width: 50, height: 50, colorSpace: "srgb" };
      },
    };
  }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useReportImage", () => {
  it("applies a live capture and clears any upload warning", () => {
    const { result } = renderHook(() => useReportImage({ isArabic: true, setErrorMsg: noop }));
    act(() => result.current.applyCapturedImage("data:image/jpeg;base64,AAA"));
    expect(result.current.image).toBe("data:image/jpeg;base64,AAA");
    expect(result.current.uploadWarning).toBeNull();

    act(() => {
      result.current.runEdgeAiPreScan("data:image/jpeg;base64,AAA");
      liveImages[liveImages.length - 1].onload?.();
    });
    act(() => result.current.resetImage());
    expect(result.current.image).toBeNull();
    expect(result.current.edgeAiStatus).toBeNull();
  });

  it("pre-scan reports fire-like pixels as a positive estimate (never proof)", async () => {
    const { result } = renderHook(() => useReportImage({ isArabic: true, setErrorMsg: noop }));
    canvasFill = [200, 80, 50]; // fire colors: high red, moderate green, low blue
    act(() => {
      result.current.runEdgeAiPreScan("data:image/jpeg;base64,FIRE", 72);
      liveImages[liveImages.length - 1].onload?.();
    });
    expect(result.current.edgeAiStatus?.success).toBe(true);
    expect(result.current.edgeAiStatus?.confidence).toBe(99);
    expect(result.current.edgeAiStatus?.messageAr).toContain("تقديري");
    expect(result.current.edgeAiStatus?.messageAr).toContain("72%");
  });

  it("pre-scan stays honest when no fire/smoke palette is found", () => {
    const { result } = renderHook(() => useReportImage({ isArabic: true, setErrorMsg: noop }));
    canvasFill = [10, 10, 10];
    act(() => {
      result.current.runEdgeAiPreScan("data:image/jpeg;base64,DARK");
      liveImages[liveImages.length - 1].onload?.();
    });
    expect(result.current.edgeAiStatus?.success).toBe(false);
    expect(result.current.edgeAiStatus?.confidence).toBe(10);
    expect(result.current.edgeAiStatus?.messageAr).toContain("لم تُرصد");
  });

  it("ignores a superseded slow pre-scan (stale capture cannot overwrite fresh)", () => {
    const { result } = renderHook(() => useReportImage({ isArabic: true, setErrorMsg: noop }));
    canvasFill = [200, 80, 50];
    act(() => result.current.runEdgeAiPreScan("data:stale-fire"));
    canvasFill = [10, 10, 10];
    act(() => result.current.runEdgeAiPreScan("data:fresh-dark"));

    // The FRESH result lands first; the STALE one resolves afterwards and
    // must be dropped by the ticket guard instead of overwriting it.
    act(() => {
      liveImages[1].onload?.(); // fresh-dark
    });
    act(() => {
      liveImages[0].onload?.(); // stale-fire (late)
    });
    expect(result.current.edgeAiStatus?.success).toBe(false);
  });
});

// ---- Offline drafts queue ----------------------------------------------------

const draftRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  lat: 36.75,
  lng: 5.06,
  locationName: "Queue",
  wilaya: "الجزائر - الجزائر (Algérie - Alger)",
  severity: "high",
  description: "Queued offline report",
  reporterName: "",
  reporterPhone: "",
  reporterType: "citizen",
  reporterBadgeCode: "",
  image: null,
  timestamp: "2025-12-31T23:00:00.000Z",
  ...overrides,
});

describe("useOfflineDraftQueue", () => {
  beforeEach(() => {
    vi.mocked(loadOfflineDrafts).mockReset();
    vi.mocked(replaceOfflineDrafts).mockReset();
    vi.mocked(removeOfflineDrafts).mockReset();
    // Fix 28b: the store returns the records AS COMMITTED — the mock echoes
    // its input, which is the store's contract for an uncontended write.
    vi.mocked(replaceOfflineDrafts).mockImplementation(async (records) => records);
  });

  it("loads persisted drafts and normalizes their shape on mount", async () => {
    vi.mocked(loadOfflineDrafts).mockResolvedValue([draftRow("d1")]);
    const { result } = renderHook(() =>
      useOfflineDraftQueue({ onSubmit: vi.fn(), isArabic: true, setSubmitting: noop })
    );
    await waitFor(() => expect(result.current.offlineDrafts).toHaveLength(1));
    expect(result.current.offlineDrafts[0].schemaVersion).toBe(1);
    expect(result.current.offlineDrafts[0].retryCount).toBe(0);
    expect(result.current.offlineDrafts[0].createdAt).toBe("2025-12-31T23:00:00.000Z");
  });

  it("auto-syncs on connectivity return, removing only accepted drafts", async () => {
    vi.mocked(loadOfflineDrafts).mockResolvedValue([draftRow("d1")]);
    const onSubmit = vi.fn().mockResolvedValue({ responseValid: true, id: "rep-1", status: "pending" });
    vi.mocked(removeOfflineDrafts).mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useOfflineDraftQueue({ onSubmit, isArabic: true, setSubmitting: noop })
    );
    await waitFor(() => expect(result.current.offlineDrafts).toHaveLength(1));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.syncStatusMsg).toContain("مزامنة"));

    // The draft is pushed with clientGeneratedId = draft.id (idempotent push).
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onSubmit).mock.calls[0][0].clientGeneratedId).toBe("d1");
    expect(removeOfflineDrafts).toHaveBeenCalledWith(["d1"]);
    await waitFor(() => expect(result.current.offlineDrafts).toHaveLength(0));
  });

  it("keeps a draft and records the retry when the server refuses it", async () => {
    vi.mocked(loadOfflineDrafts).mockResolvedValue([draftRow("d1", { retryCount: 1 })]);
    const onSubmit = vi.fn().mockRejectedValue(new Error("network down"));
    vi.mocked(removeOfflineDrafts).mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useOfflineDraftQueue({ onSubmit, isArabic: true, setSubmitting: noop })
    );
    await waitFor(() => expect(result.current.offlineDrafts).toHaveLength(1));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.syncStatusMsg).toContain("فشلت"));

    // The tombstone sweep runs with an EMPTY id list on refusal — nothing is
    // removed from the durable store.
    expect(removeOfflineDrafts).toHaveBeenCalledWith([]);
    await waitFor(() => {
      expect(result.current.offlineDrafts[0].retryCount).toBe(2);
      expect(result.current.offlineDrafts[0].lastError).toBe("network down");
    });
  });

  it("never claims success when the durable queue fails to commit", async () => {
    vi.mocked(loadOfflineDrafts).mockResolvedValue([draftRow("d1")]);
    const onSubmit = vi.fn().mockResolvedValue({ responseValid: true, id: "rep-1", status: "pending" });
    vi.mocked(replaceOfflineDrafts).mockRejectedValue(new Error("quota"));

    const { result } = renderHook(() =>
      useOfflineDraftQueue({ onSubmit, isArabic: true, setSubmitting: noop })
    );
    await waitFor(() => expect(result.current.offlineDrafts).toHaveLength(1));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.syncStatusMsg).toContain("تعذر تحديث طابور"));

    // Snapshot preserved in memory despite server acceptance — no loss.
    expect(result.current.offlineDrafts).toHaveLength(1);
    expect(removeOfflineDrafts).not.toHaveBeenCalled();
  });

  // Fix 28b: the hook holds the records AS COMMITTED — the store restamps
  // on write, so state must come from the store's return value, not from
  // the pre-write snapshot. The mock returns a restamped record; if the
  // hook kept its own snapshot, the stamp would stay undefined.
  it("holds the committed records the store returns, not the pre-write snapshot", async () => {
    vi.mocked(loadOfflineDrafts).mockResolvedValue([draftRow("d1")]);
    const onSubmit = vi.fn().mockRejectedValue(new Error("network down"));
    vi.mocked(replaceOfflineDrafts).mockImplementation(async (records) => [
      { ...records[0], updatedAt: 9999999999999 },
    ]);
    vi.mocked(removeOfflineDrafts).mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useOfflineDraftQueue({ onSubmit, isArabic: true, setSubmitting: noop })
    );
    await waitFor(() => expect(result.current.offlineDrafts).toHaveLength(1));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.syncStatusMsg).toContain("فشلت"));

    await waitFor(() => {
      expect(result.current.offlineDrafts[0].updatedAt).toBe(9999999999999);
      expect(result.current.offlineDrafts[0].retryCount).toBe(1);
    });
  });

  // Fix 28 (RFSH-1): a moderated replay must not wedge the queue — the
  // oldest draft was already resolved by a moderator, so the server replays
  // it with status "resolved"; the loop must accept it and move on to the
  // newer draft behind it instead of throwing and breaking at the oldest.
  it("syncs past a moderator-resolved replay and clears the whole queue", async () => {
    vi.mocked(loadOfflineDrafts).mockResolvedValue([draftRow("d1"), draftRow("d2")]);
    const onSubmit = vi.fn(async (payload: { clientGeneratedId: string }) =>
      payload.clientGeneratedId === "d1"
        ? { responseValid: true, id: "rep-old", status: "resolved" }
        : { responseValid: true, id: "rep-new", status: "pending" },
    );
    vi.mocked(removeOfflineDrafts).mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useOfflineDraftQueue({ onSubmit, isArabic: true, setSubmitting: noop })
    );
    await waitFor(() => expect(result.current.offlineDrafts).toHaveLength(2));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.syncStatusMsg).toContain("تم قبول ومزامنة"));

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(removeOfflineDrafts).toHaveBeenCalledWith(["d1", "d2"]);
    await waitFor(() => expect(result.current.offlineDrafts).toHaveLength(0));
  });
});

// ---- Submit orchestration ----------------------------------------------------

const validValues = {
  lat: "36.75",
  lng: "5.06",
  locationName: "Ridge",
  wilaya: "الجزائر - الجزائر (Algérie - Alger)",
  severity: "high",
  description: "A sufficiently long description",
  reporterName: "",
  reporterPhone: "",
  reporterType: "citizen",
  reporterBadgeCode: "",
};

const submitHarness = (overrides: {
  values?: Partial<typeof validValues>;
  drafts?: { isOffline?: boolean; isOfflineSimulation?: boolean; persistDraft?: (d: any) => Promise<boolean> };
  onSubmit?: (data: any) => Promise<any>;
} = {}) => {
  const fields = {
    values: { ...validValues, ...overrides.values },
    resetForNextReport: vi.fn(),
  };
  const image = { image: "data:image/jpeg;base64,AAA" as string | null, compressedSize: "12.0 KB", resetImage: vi.fn() };
  const camera = { resetOrientation: vi.fn() };
  const drafts = {
    isOffline: false,
    isOfflineSimulation: false,
    persistDraft: vi.fn(async () => true),
    ...overrides.drafts,
  };
  const onSubmit = overrides.onSubmit ?? vi.fn().mockResolvedValue({ responseValid: true, id: "rep-1", status: "pending" });
  const errorMsgs: Array<string | null> = [];
  const hooks = renderHook(() =>
    useReportSubmit({
      onSubmit,
      isArabic: true,
      fields,
      image,
      camera,
      drafts,
      setSubmitting: noop,
      setErrorMsg: (m: string | null) => errorMsgs.push(m),
    })
  );
  return { ...hooks, fields, image, camera, drafts, onSubmit, errorMsgs };
};

describe("useReportSubmit", () => {
  it("blocks early validation problems with the localized copy", async () => {
    const { result, errorMsgs } = submitHarness({ values: { lat: "", lng: "" } });
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: noop } as never);
    });
    expect(errorMsgs[errorMsgs.length - 1]).toContain("الموقع الجغرافي");
  });

  it("enforces the description floor and the optional-phone policy", async () => {
    const short = submitHarness({ values: { description: "قصير" } });
    await act(async () => {
      await short.result.current.handleSubmit({ preventDefault: noop } as never);
    });
    expect(short.errorMsgs[short.errorMsgs.length - 1]).toContain("10 أحرف");

    const badPhone = submitHarness({ values: { reporterPhone: "not-a-phone" } });
    await act(async () => {
      await badPhone.result.current.handleSubmit({ preventDefault: noop } as never);
    });
    expect(badPhone.errorMsgs[badPhone.errorMsgs.length - 1]).toContain("رقم هاتف صالح");
  });

  it("intercepts offline mode: durable draft, no transport call, no badge trust", async () => {
    const { result, drafts, onSubmit, fields, image, camera } = submitHarness({
      drafts: { isOfflineSimulation: true },
      values: { reporterBadgeCode: "SHOULD-NOT-ACTIVATE" },
    });
    let success: any = null;
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: noop } as never);
    });
    success = result.current.successReport;
    expect(drafts.persistDraft).toHaveBeenCalledTimes(1);
    const queued = vi.mocked(drafts.persistDraft).mock.calls[0][0];
    expect(queued.isOfflineDraft).toBe(true);
    expect(queued.status).toBe("pending");
    expect(queued.clientGeneratedId).toBe(queued.id);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(setReporterBadge).not.toHaveBeenCalled();
    expect(success.isOfflineDraft).toBe(true);
    expect(success.aiVerification).toBeNull(); // no on-device AI fabrication
    expect(fields.resetForNextReport).toHaveBeenCalledTimes(1);
    expect(image.resetImage).toHaveBeenCalledTimes(1);
    expect(camera.resetOrientation).toHaveBeenCalledTimes(1);
  });

  it("sends online submissions with an idempotency key and activates the badge only on server-verified", async () => {
    const { result, onSubmit } = submitHarness({
      values: { reporterBadgeCode: "ABC123" },
      onSubmit: vi.fn().mockResolvedValue({ responseValid: true, id: "rep-9", status: "verified" }),
    });
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: noop } as never);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(onSubmit).mock.calls[0][0];
    expect(typeof payload.clientGeneratedId).toBe("string");
    expect(payload.clientGeneratedId.length).toBeGreaterThan(10);
    expect(payload.reporterBadgeCode).toBe("ABC123");
    expect(setReporterBadge).toHaveBeenCalledWith("ABC123");
    expect(result.current.successReport?.status).toBe("verified");
  });

  it("never activates the badge on a pending server answer", async () => {
    const { result, onSubmit } = submitHarness({
      values: { reporterBadgeCode: "ABC123" },
      onSubmit: vi.fn().mockResolvedValue({ responseValid: true, id: "rep-9", status: "pending" }),
    });
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: noop } as never);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(setReporterBadge).not.toHaveBeenCalled();
  });

  it("maps raw server errors behind the honest user-facing copy", async () => {
    let observed: string | null = null;
    const setErrorMsg = (m: string | null) => {
      observed = m;
    };
    const hooks = renderHook(() =>
      useReportSubmit({
        onSubmit: vi.fn().mockRejectedValue({ data: { error: "Admin Firestore durable idempotency is required for report submission" } }),
        isArabic: true,
        fields: { values: validValues, resetForNextReport: vi.fn() },
        image: { image: null, compressedSize: null, resetImage: vi.fn() },
        camera: { resetOrientation: vi.fn() },
        drafts: { isOffline: false, isOfflineSimulation: false, persistDraft: vi.fn(async () => true) },
        setSubmitting: noop,
        setErrorMsg,
      })
    );
    await act(async () => {
      await hooks.result.current.handleSubmit({ preventDefault: noop } as never);
    });
    expect(observed).toContain("خادم المرصد غير جاهز");
    expect(observed).not.toContain("Admin Firestore");
  });

  it("keeps the form filled when the durable draft commit fails", async () => {
    const { result, drafts, errorMsgs } = submitHarness({
      drafts: { isOfflineSimulation: true, persistDraft: vi.fn(async () => false) },
    });
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: noop } as never);
    });
    expect(drafts.persistDraft).toHaveBeenCalledTimes(1);
    expect(result.current.successReport).toBeNull();
    expect(errorMsgs[errorMsgs.length - 1]).toContain("تعذر حفظ البلاغ محليًا");
  });
});
