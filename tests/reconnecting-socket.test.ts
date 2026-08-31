import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextReconnectDelayMs, ReconnectingSocket } from "../src/hooks/useReconnectingSocket.js";

/**
 * ARC-M14: contract tests for the single reconnecting-socket engine that now
 * drives both WebSocket clients (mesh + live events): heartbeat, quiet-socket
 * watchdog, and jittered reconnect backoff.
 */

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(raw: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(raw);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(raw: string): void {
    this.onmessage?.({ data: raw });
  }
}

// The engine is typed against the DOM WebSocket; the fake models the surface
// the engine actually touches (readyState, send, close, event handlers).
const makeFake = (ws: FakeWebSocket): WebSocket => ws as unknown as WebSocket;

describe("nextReconnectDelayMs — equal-jitter backoff", () => {
  it("stays inside [base/2, base) for the given attempt", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(nextReconnectDelayMs(0, 1_000, 30_000)).toBe(500);
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    // Math.round makes the upper bound inclusive: [base/2, base].
    expect(nextReconnectDelayMs(0, 1_000, 30_000)).toBeLessThanOrEqual(1_000);
    expect(nextReconnectDelayMs(0, 1_000, 30_000)).toBeGreaterThanOrEqual(500);
  });

  it("grows exponentially but never exceeds the cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(nextReconnectDelayMs(1, 1_000, 30_000)).toBe(1_000);
    expect(nextReconnectDelayMs(2, 1_000, 30_000)).toBe(2_000);
    expect(nextReconnectDelayMs(3, 1_000, 30_000)).toBe(4_000);
    expect(nextReconnectDelayMs(4, 1_000, 30_000)).toBe(8_000);
    expect(nextReconnectDelayMs(5, 1_000, 30_000)).toBe(15_000); // capped at 30s, half jitter
    expect(nextReconnectDelayMs(6, 1_000, 30_000)).toBe(15_000);
    expect(nextReconnectDelayMs(50, 1_000, 30_000)).toBe(15_000);
  });

  it("never returns the same delay for two different random draws (jitter present)", () => {
    const spy = vi.spyOn(Math, "random");
    spy.mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    const a = nextReconnectDelayMs(3, 1_000, 30_000);
    const b = nextReconnectDelayMs(3, 1_000, 30_000);
    expect(a).toBe(4_000);
    expect(b).toBe(6_000);
  });
});

describe("ReconnectingSocket — shared engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the heartbeat payload on the configured interval once open", async () => {
    const sockets: FakeWebSocket[] = [];
    const socket = new ReconnectingSocket({
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return makeFake(ws);
      },
      heartbeatMs: 1_000,
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    sockets[0].simulateOpen();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(sockets[0].sent.filter((raw) => raw.includes("ping"))).toHaveLength(2);
  });

  it("force-closes a quiet (half-open) socket and reconnects with jittered delay", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // deterministic: delay = base/2
    const sockets: FakeWebSocket[] = [];
    const downs = vi.fn();
    const socket = new ReconnectingSocket({
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return makeFake(ws);
      },
      heartbeatMs: 1_000,
      quietSocketMs: 5_000,
      onDown: downs,
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].simulateOpen();

    // Keep the link fresh: inbound traffic resets the quiet window.
    await vi.advanceTimersByTimeAsync(3_000);
    sockets[0].simulateMessage('{"type":"pong"}');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets).toHaveLength(1); // still healthy
    expect(downs).not.toHaveBeenCalled();

    // Now go silent past the quiet window — the watchdog must rebuild.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sockets[0].closed).toBe(true);
    expect(downs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500); // equal-jitter delay for attempt 0 = 500ms
    expect(sockets).toHaveLength(2); // replacement socket created
  });

  it("schedules a jittered reconnect after the server closes the socket", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const sockets: FakeWebSocket[] = [];
    const socket = new ReconnectingSocket({
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return makeFake(ws);
      },
      heartbeatMs: 0,
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    sockets[0].simulateOpen();
    sockets[0].close(); // server restart / network drop
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(1); // not yet — attempt 0 delay is 500ms
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
  });

  it("disconnect() cancels pending reconnects and ignores the stale close", async () => {
    const sockets: FakeWebSocket[] = [];
    const socket = new ReconnectingSocket({
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return makeFake(ws);
      },
      heartbeatMs: 0,
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].simulateOpen();
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1); // no reconnect after manual close
  });

  it("does not open twice when connect() is called while connecting or open", async () => {
    const sockets: FakeWebSocket[] = [];
    const socket = new ReconnectingSocket({
      createSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return makeFake(ws);
      },
      heartbeatMs: 0,
    });
    socket.connect();
    socket.connect();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].simulateOpen();
    socket.connect();
    expect(sockets).toHaveLength(1);
  });

  it("reports onDown and schedules a reconnect when socket creation fails", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let fail = true;
    const sockets: FakeWebSocket[] = [];
    const downs = vi.fn();
    const socket = new ReconnectingSocket({
      createSocket: () => {
        if (fail) throw new Error("unreachable");
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return makeFake(ws);
      },
      heartbeatMs: 0,
      onDown: downs,
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(downs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(0); // second attempt also fails
    expect(downs).toHaveBeenCalledTimes(2);

    fail = false;
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 delay = 1000ms (equal jitter, random=0)
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    sockets[0].simulateOpen();
    expect(socket.getState()).toBe("open");
  });
});
