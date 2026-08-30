import { useEffect, useRef } from "react";

/**
 * ARC-M14: the app used to run TWO independent WebSocket clients against the
 * same server with different conventions — the mesh socket (heartbeat every
 * 30s, graduated reconnect) and the live-events socket (no heartbeat at all,
 * so a half-open connection behind a proxy stayed silently dead until the
 * GET poll hid it), both reconnecting with an unjittered doubling delay that
 * stampeded the server after every restart.
 *
 * This module is now the single socket convention for both clients:
 * - a heartbeat keeps proxies/NAT gateways from dropping idle connections and
 *   gives TCP a chance to surface a broken link;
 * - an optional quiet-socket watchdog force-closes a connection that has seen
 *   NO inbound traffic for `quietSocketMs` (only safe when the server answers
 *   pings, as the mesh hub does — the live hub ignores inbound, so its quiet
 *   windows are normal);
 * - reconnects use equal-jitter exponential backoff, so a fleet of clients
 *   that lost the same server restart spreads its reconnection over the
 *   backoff window instead of arriving in unison.
 */

export interface ReconnectingSocketOptions {
  /** Builds each attempt's socket; may be async (e.g. fetch a token first). */
  createSocket: () => Promise<WebSocket> | WebSocket;
  /** Ping interval in ms (0 disables). Default 30s. */
  heartbeatMs?: number;
  /** Outbound heartbeat frame. Default `{"type":"ping"}`. */
  pingPayload?: () => string;
  /** Force-close after this much inbound silence (0 disables). Default 0. */
  quietSocketMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Socket is open and writable. */
  onOpen?: (send: (raw: string) => boolean) => void;
  onMessage?: (event: MessageEvent) => void;
  /** The link went down (close, error, or failed creation). */
  onDown?: () => void;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_PING_PAYLOAD = () => JSON.stringify({ type: "ping" });

/**
 * Equal-jitter backoff (AWS style): the delay is half fixed, half random, so
 * simultaneous reconnect attempts spread over [base/2, base) instead of
 * stampeding the recovering server in unison.
 */
export function nextReconnectDelayMs(
  attempt: number,
  initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS
): number {
  const base = Math.min(initialBackoffMs * 2 ** Math.max(0, attempt), maxBackoffMs);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

export type SocketEngineState = "idle" | "connecting" | "open";

// ARC-M14 note: this engine runs in the browser AND under the node test
// environment (the vitest suites deliberately overlap — ARC-L26), so timers
// use the ambient globals, never `window.*`.
type TimerHandle = ReturnType<typeof setTimeout>;

export class ReconnectingSocket {
  private options: ReconnectingSocketOptions;
  private ws: WebSocket | null = null;
  private generation = 0;
  private manualClosed = false;
  private connecting = false;
  private attempt = 0;
  private reconnectTimer: TimerHandle | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private lastInboundAt = 0;

  constructor(options: ReconnectingSocketOptions) {
    this.options = options;
  }

  /** Hot-swap callbacks (a React hook keeps closures fresh with this). */
  updateOptions(next: ReconnectingSocketOptions): void {
    this.options = next;
  }

  getState(): SocketEngineState {
    if (this.ws?.readyState === WebSocket.OPEN) return "open";
    return this.connecting || this.reconnectTimer !== null ? "connecting" : "idle";
  }

  connect(): void {
    if (this.getState() !== "idle") return;
    this.manualClosed = false;
    this.connecting = true;
    void this.open();
  }

  disconnect(): void {
    this.manualClosed = true;
    this.generation += 1;
    this.connecting = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // already torn down
      }
    }
  }

  send(raw: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(raw);
      return true;
    } catch {
      return false;
    }
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    let ws: WebSocket;
    try {
      ws = await this.options.createSocket();
    } catch {
      if (this.manualClosed || generation !== this.generation) return;
      this.connecting = false;
      this.options.onDown?.();
      this.scheduleReconnect();
      return;
    }
    // disconnect() (or a newer attempt) while createSocket was in flight.
    if (this.manualClosed || generation !== this.generation) {
      try {
        ws.close();
      } catch {
        // already closed
      }
      return;
    }
    this.connecting = false;
    this.ws = ws;
    this.lastInboundAt = Date.now();

    ws.onopen = () => {
      if (this.manualClosed || generation !== this.generation || this.ws !== ws) return;
      this.attempt = 0;
      this.startHeartbeat();
      this.options.onOpen?.((raw) => this.send(raw));
    };
    ws.onmessage = (event) => {
      if (this.manualClosed || generation !== this.generation || this.ws !== ws) return;
      this.lastInboundAt = Date.now();
      this.options.onMessage?.(event);
    };
    ws.onclose = () => {
      if (this.manualClosed || generation !== this.generation || this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      this.options.onDown?.();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and drives the reconnect; nothing to do here.
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const heartbeatMs = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const quietMs = this.options.quietSocketMs ?? 0;
      if (quietMs > 0 && Date.now() - this.lastInboundAt > quietMs) {
        // Half-open link behind a proxy: our sends buffer into a dead peer
        // and nothing has come back for quietSocketMs. Force-close so the
        // close path rebuilds the connection instead of staying silently
        // dead until some other surface hides it.
        try {
          this.ws.close();
        } catch {
          // close races are harmless; onclose still fires
        }
        return;
      }
      this.send((this.options.pingPayload ?? DEFAULT_PING_PAYLOAD)());
    }, heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClosed || this.reconnectTimer !== null) return;
    const delay = nextReconnectDelayMs(
      this.attempt,
      this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    );
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connecting = true;
      void this.open();
    }, delay);
  }
}

/**
 * React binding: one socket per component lifetime, fresh callbacks on every
 * render, connect on mount, full teardown (including pending reconnects) on
 * unmount.
 */
export function useReconnectingSocket(options: ReconnectingSocketOptions): ReconnectingSocket {
  const socketRef = useRef<ReconnectingSocket | null>(null);
  if (socketRef.current === null) socketRef.current = new ReconnectingSocket(options);
  const socket = socketRef.current;
  const latestRef = useRef(options);
  latestRef.current = options;

  // Refresh closures after every render (no dep array on purpose).
  useEffect(() => {
    socket.updateOptions(latestRef.current);
  });

  useEffect(() => {
    socket.connect();
    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  return socket;
}
