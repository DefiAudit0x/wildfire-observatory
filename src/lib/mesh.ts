import { ReconnectingSocket } from "../hooks/useReconnectingSocket";
import { getDeviceId as getCanonicalDeviceId } from "../utils/device";

export type MeshStatus = "connecting" | "online" | "offline";

export interface MeshNodeInfo {
  id: string;
  label: string;
  lastSeen: number;
}

export interface MeshMessage {
  type: string;
  ts?: number;
  [key: string]: unknown;
}

type MessageHandler = (message: MeshMessage) => void;
type StatusHandler = (status: MeshStatus, nodeCount: number, nodes: MeshNodeInfo[]) => void;

// ARC-M14: connection lifecycle (heartbeat, half-open watchdog, jittered
// backoff) lives in the shared ReconnectingSocket engine — this client keeps
// only what is mesh-specific: the device identity, the short-lived mesh
// token, and the node/status fan-out.
const HEARTBEAT_MS = 30_000;
// The mesh hub answers every {"type":"ping"} with a pong, so >2 missed
// heartbeat windows of total inbound silence means the link is dead behind a
// proxy — force-close and rebuild instead of staying silently half-open.
const QUIET_SOCKET_MS = 75_000;
const FETCH_TOKEN_TIMEOUT_MS = 10_000;
// M15: the mesh client no longer mints a parallel `dev-<uuid>` identity.
// It uses the one canonical device id (src/utils/device.ts), which migrates
// the legacy localStorage["mesh_device_id"] value on first read. The hub
// treats this value as a display label only — the JWT subject stays the
// authoritative identity for every mesh security decision.

class MeshClient {
  private engine: ReconnectingSocket;
  private deviceId = getCanonicalDeviceId();
  private label = this.buildLabel();
  private status: MeshStatus = "offline";
  private nodeCount = 0;
  private nodes: MeshNodeInfo[] = [];
  private meshToken: string | null = null;
  private tokenController: AbortController | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();

  constructor() {
    this.engine = new ReconnectingSocket({
      createSocket: () => this.openSocket(),
      heartbeatMs: HEARTBEAT_MS,
      quietSocketMs: QUIET_SOCKET_MS,
      onOpen: (send) => {
        send(JSON.stringify({ type: "hello", deviceId: this.deviceId, label: this.label, token: this.meshToken }));
      },
      onMessage: (event) => this.handleMessage(event),
      onDown: () => {
        // The token is short-lived; fetch a fresh one on reconnect.
        this.meshToken = null;
        this.setStatus("offline");
      },
    });
  }

  private buildLabel(): string {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return "هاتف أندرويد";
    if (/iphone|ipad|ipod/i.test(ua)) return "آيفون / آيباد";
    if (/windows/i.test(ua)) return "حاسوب ويندوز";
    if (/mac/i.test(ua)) return "حاسوب ماك";
    return "عقدة المرصد";
  }

  connect(): void {
    if (this.engine.getState() !== "idle") return;
    this.setStatus("connecting");
    this.engine.connect();
  }

  disconnect(): void {
    this.tokenController?.abort();
    this.tokenController = null;
    this.engine.disconnect();
    this.setStatus("offline");
  }

  /** Token-gated socket factory — the engine's reconnect loop drives this. */
  private async openSocket(): Promise<WebSocket> {
    const controller = new AbortController();
    this.tokenController?.abort();
    this.tokenController = controller;
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TOKEN_TIMEOUT_MS);
    try {
      if (!this.meshToken) {
        const res = await fetch(`/api/mesh/token?deviceId=${encodeURIComponent(this.deviceId)}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("mesh token unavailable");
        const data = (await res.json()) as { token?: unknown };
        this.meshToken = typeof data.token === "string" && data.token.length > 0 ? data.token : null;
        if (!this.meshToken) throw new Error("mesh token unavailable");
      }
    } finally {
      window.clearTimeout(timeout);
      if (this.tokenController === controller) this.tokenController = null;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(`${protocol}//${location.host}/ws`);
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(String(event.data)) as MeshMessage;
      if (message.type === "welcome") {
        const nodeCount = parseNodeCount(message.nodeCount, 0);
        const nodes = parseNodes(message.nodes);
        if (nodeCount === null || nodes === null) return;
        this.nodeCount = nodeCount;
        this.nodes = nodes;
        this.setStatus("online");
      } else if (message.type === "node:joined") {
        const nodeCount = parseNodeCount(message.nodeCount, this.nodeCount);
        const node = parseNode(message.node);
        if (nodeCount === null || node === null) return;
        this.nodeCount = nodeCount;
        this.nodes = [...this.nodes.filter((n) => n.id !== node.id), node];
        this.emitStatus();
      } else if (message.type === "node:left") {
        const nodeCount = parseNodeCount(message.nodeCount, this.nodeCount);
        if (nodeCount === null) return;
        this.nodeCount = nodeCount;
        if (typeof message.nodeId === "string") {
          this.nodes = this.nodes.filter((n) => n.id !== message.nodeId);
        }
        this.emitStatus();
      } else if (message.type === "error") {
        // Log only; connection stays alive
      }
      this.messageHandlers.forEach((handler) => {
        try {
          handler(message);
        } catch {
          // One consumer must not prevent delivery to the remaining listeners.
        }
      });
    } catch {
      // Ignore malformed frames
    }
  }

  private setStatus(status: MeshStatus): void {
    this.status = status;
    this.emitStatus();
  }

  private emitStatus(): void {
    const nodes = this.nodes.slice();
    this.statusHandlers.forEach((handler) => {
      try {
        handler(this.status, this.nodeCount, nodes);
      } catch {
        // One status consumer must not block the remaining subscribers.
      }
    });
  }

  send(message: MeshMessage): boolean {
    return this.engine.send(JSON.stringify(message));
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status, this.nodeCount, this.nodes);
    return () => this.statusHandlers.delete(handler);
  }

  getStatus(): MeshStatus {
    return this.status;
  }

  getNodeCount(): number {
    return this.nodeCount;
  }
}

function parseNodeCount(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseNode(value: unknown): MeshNodeInfo | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  return typeof node.id === "string" &&
    typeof node.label === "string" &&
    typeof node.lastSeen === "number" &&
    Number.isFinite(node.lastSeen)
    ? { id: node.id, label: node.label, lastSeen: node.lastSeen }
    : null;
}

function parseNodes(value: unknown): MeshNodeInfo[] | null {
  if (!Array.isArray(value)) return [];
  const nodes = value.map(parseNode);
  return nodes.every((node): node is MeshNodeInfo => node !== null) ? nodes : null;
}

export const meshClient = new MeshClient();
