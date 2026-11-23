// Fix 27 — TrappedSOSModal lifecycle (SOSM-1/2/3).
// jsdom has no MediaRecorder / FileReader data / AudioContext, so the spec
// mocks all three. The FileReader mock resolves ASYNCHRONOUSLY (via
// queueMicrotask) on purpose: the ms-race case (SOSM-2) needs the auto-stop
// conversion to still be pending when Send is tapped.
import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TrappedSOSModal from "../../src/components/TrappedSOSModal";

const CANNED_AUDIO = "data:audio/webm;base64," + "QUJD".repeat(50);
const LOC = { lat: 36.7, lng: 3.1 };
const THREAT = { distanceM: 500, kind: "report" as const };

const recorderInstances: MockMediaRecorder[] = [];

class MockMediaRecorder {
  static isTypeSupported = (_mime: string) => false;
  /** Fix 27b: when true, stop() flips state at once but delivers the final
      chunk + onstop on a later microtask — the real MediaRecorder ordering
      (state is inactive synchronously, the final dataavailable is queued). */
  static asyncStop = false;
  state: "recording" | "inactive" = "recording";
  mimeType = "";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    public stream: unknown,
    public options?: { mimeType?: string },
  ) {
    recorderInstances.push(this);
  }
  start(_timeslice?: number) {}
  stop() {
    this.state = "inactive";
    if (MockMediaRecorder.asyncStop) {
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(300)]) });
        this.onstop?.();
      });
    } else {
      this.onstop?.();
    }
  }
}

class MockFileReader {
  /** Fix 27b (review Trivial): every Blob handed to readAsDataURL, in
      order — the mock resolves the same canned string for any blob, so
      asserting only audioUrl cannot catch a truncated conversion. */
  static blobSizes: number[] = [];
  result: string | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    MockFileReader.blobSizes.push(blob.size);
    // Deliberately async: the onstop conversion must be pending until the
    // test flushes microtasks, so the ms-race case is real.
    queueMicrotask(() => {
      this.result = CANNED_AUDIO;
      this.onloadend?.();
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const getUserMediaMock = vi.fn();
const sosBodies: Record<string, unknown>[] = [];

function fakeStream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], track };
}

function renderModal(props: { userLocation?: { lat: number; lng: number } | null; nearestThreat?: typeof THREAT | null } = {}) {
  const onClose = vi.fn();
  const utils = render(
    <TrappedSOSModal
      lang="ar"
      onClose={onClose}
      userLocation={props.userLocation === undefined ? LOC : props.userLocation}
      nearestThreat={props.nearestThreat === undefined ? THREAT : props.nearestThreat}
    />,
  );
  return { ...utils, onClose };
}

/** Click the verified-step start button and resolve the mic grant. */
async function startRecording() {
  fireEvent.click(screen.getByText("اضغط لبدء تسجيل الاستغاثة الصوتية"));
  await act(async () => {});
}

function emitChunk() {
  const recorder = recorderInstances[0];
  act(() => {
    recorder.ondataavailable?.({ data: new Blob([new Uint8Array(300)]) });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  recorderInstances.length = 0;
  MockMediaRecorder.asyncStop = false;
  MockFileReader.blobSizes = [];
  sosBodies.length = 0;
  getUserMediaMock.mockReset();
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  vi.stubGlobal("FileReader", MockFileReader);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: getUserMediaMock },
    configurable: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sos/profile/current") {
        return { ok: true, status: 200, json: async () => ({ name: "", phone: "" }) } as Response;
      }
      if (url === "/api/sos/profile") {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      if (url === "/api/sos") {
        sosBodies.push(JSON.parse(init?.body as string));
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Fix 27 SOSM-1 — verification effect is pre-recording only", () => {
  it("a fresh GPS fix mid-recording does not reset the flow", async () => {
    const stream = fakeStream();
    getUserMediaMock.mockResolvedValue(stream);
    const { rerender } = renderModal();
    expect(screen.getByText("تم تأكيد حالة الخطر المحدق")).toBeTruthy();
    await startRecording();
    expect(recorderInstances).toHaveLength(1);
    expect(screen.getByText("إنهاء التسجيل وإرسال الصوت والموقع فوراً 🚨")).toBeTruthy();
    // A routine GPS fix mints a NEW location object — same values, new
    // identity — exactly what the GPS watcher does every fix.
    rerender(
      <TrappedSOSModal lang="ar" onClose={vi.fn()} userLocation={{ ...LOC }} nearestThreat={THREAT} />,
    );
    await act(async () => {});
    expect(screen.getByText("إنهاء التسجيل وإرسال الصوت والموقع فوراً 🚨")).toBeTruthy();
    expect(screen.queryByText("اضغط لبدء تسجيل الاستغاثة الصوتية")).toBeNull();
  });

  it("a fresh threat object after a successful send does not remove the success screen", async () => {
    const stream = fakeStream();
    getUserMediaMock.mockResolvedValue(stream);
    const { rerender } = renderModal();
    await startRecording();
    fireEvent.click(screen.getByText("إنهاء التسجيل وإرسال الصوت والموقع فوراً 🚨"));
    await act(async () => {});
    expect(screen.getByText("تم استلام ونشر نداء الاستغاثة!")).toBeTruthy();
    rerender(
      <TrappedSOSModal lang="ar" onClose={vi.fn()} userLocation={LOC} nearestThreat={{ distanceM: 400, kind: "report" }} />,
    );
    await act(async () => {});
    expect(screen.getByText("تم استلام ونشر نداء الاستغاثة!")).toBeTruthy();
  });

  it("pre-recording verification still follows live props (control)", async () => {
    const { rerender } = renderModal({ userLocation: null });
    expect(screen.getByText("تعذّر تحديد موقعك")).toBeTruthy();
    rerender(<TrappedSOSModal lang="ar" onClose={vi.fn()} userLocation={LOC} nearestThreat={THREAT} />);
    await act(async () => {});
    expect(screen.getByText("تم تأكيد حالة الخطر المحدق")).toBeTruthy();
  });
});

describe("Fix 27 SOSM-2 — the auto-stopped take is sent", () => {
  it("a full 20 s take reaches the server as real audio, with duration 20", async () => {
    const stream = fakeStream();
    getUserMediaMock.mockResolvedValue(stream);
    renderModal();
    await startRecording();
    emitChunk();
    await vi.advanceTimersByTimeAsync(20000);
    await act(async () => {});
    expect(screen.getByText("00:20")).toBeTruthy();
    expect(screen.getByText("انتهى التسجيل (20 ثانية) — اضغط لإرسال الصوت والموقع فوراً")).toBeTruthy();
    fireEvent.click(screen.getByText("إنهاء التسجيل وإرسال الصوت والموقع فوراً 🚨"));
    await act(async () => {});
    expect(sosBodies).toHaveLength(1);
    expect(sosBodies[0].audioUrl).toBe(CANNED_AUDIO);
    expect(sosBodies[0].audioDuration).toBe(20);
    // Fix 27b (review Trivial): the conversion that produced the sent
    // audio saw the one emitted 300-byte chunk.
    expect(MockFileReader.blobSizes[0]).toBe(300);
    expect(screen.getByText("تم استلام ونشر نداء الاستغاثة!")).toBeTruthy();
  });

  it("Send tapped before the onstop conversion resolves still sends the real take (ms race)", async () => {
    const stream = fakeStream();
    getUserMediaMock.mockResolvedValue(stream);
    renderModal();
    await startRecording();
    emitChunk();
    // The recorder stops from outside the send path (the timer auto-stop in
    // production) while the onstop FileReader is still pending — the retry
    // cache is empty at this point. Awaiting anything here would let the
    // FileReader resolve and hide the race, so Send is tapped synchronously.
    recorderInstances[0].stop();
    fireEvent.click(screen.getByText("إنهاء التسجيل وإرسال الصوت والموقع فوراً 🚨"));
    await act(async () => {});
    expect(sosBodies).toHaveLength(1);
    expect(sosBodies[0].audioUrl).toBe(CANNED_AUDIO);
  });

  it("Send tapped before the timer-stop's final slice lands still sends the whole take (27b)", async () => {
    // The real MediaRecorder flips state to inactive synchronously while
    // the final ~100 ms slice is still a queued task. stop() in async mode
    // delivers that slice (300 bytes) only on a later microtask — Send is
    // tapped synchronously in between, so the conversion that feeds the
    // POST must wait for it instead of snapshotting the chunks at once.
    MockMediaRecorder.asyncStop = true;
    const stream = fakeStream();
    getUserMediaMock.mockResolvedValue(stream);
    renderModal();
    await startRecording();
    emitChunk(); // 300 bytes during recording
    recorderInstances[0].stop();
    fireEvent.click(screen.getByText("إنهاء التسجيل وإرسال الصوت والموقع فوراً 🚨"));
    await act(async () => {});
    expect(sosBodies).toHaveLength(1);
    expect(sosBodies[0].audioUrl).toBe(CANNED_AUDIO);
    // The conversion that produced the sent audio saw BOTH chunks (300
    // during recording + 300 final slice) — on old code the snapshot ran
    // first and blobSizes[0] was 300.
    expect(MockFileReader.blobSizes[0]).toBe(600);
  });
});

describe("Fix 27 SOSM-3 — close during the permission await leaks nothing", () => {
  it("a stream granted after close is stopped at once and never recorded", async () => {
    const gate = deferred<unknown>();
    getUserMediaMock.mockReturnValue(gate.promise);
    const stream = fakeStream();
    const { unmount, container } = renderModal();
    fireEvent.click(screen.getByText("اضغط لبدء تسجيل الاستغاثة الصوتية"));
    await act(async () => {});
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    // The header close button stays live during the await — close wins.
    const closeBtn = container.querySelector(".bg-red-600 button");
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn!);
    unmount();
    await act(async () => {
      gate.resolve(stream);
    });
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    expect(recorderInstances).toHaveLength(0);
  });

  it("a grant while mounted still records (control)", async () => {
    const stream = fakeStream();
    getUserMediaMock.mockResolvedValue(stream);
    // Fix 27 review (Minor 1): render under StrictMode so the mountedRef
    // lifecycle is pinned — StrictMode double-invokes the mount cleanup,
    // and without the setup reset the disposed flag would stick false and
    // the granted stream would be discarded as "disposed".
    const onClose = vi.fn();
    render(
      <StrictMode>
        <TrappedSOSModal lang="ar" onClose={onClose} userLocation={LOC} nearestThreat={THREAT} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByText("اضغط لبدء تسجيل الاستغاثة الصوتية"));
    await act(async () => {});
    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0].state).toBe("recording");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("00:01")).toBeTruthy();
  });
});
