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

const HEARTBEAT_MS = 30_000;
const FETCH_TOKEN_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEVICE_ID_KEY = "mesh_device_id";
let memoryDeviceId: string | null = null;

function getDeviceId(): string {
  const storage = typeof localStorage !== "undefined" ? localStorage : null;
  let id = storage?.getItem(DEVICE_ID_KEY) ?? memoryDeviceId;
  if (!id) {
    id = `dev-${crypto.randomUUID()}`;
    memoryDeviceId = id;
    try {
      storage?.setItem(DEVICE_ID_KEY, id);
    } catch {
      // Private browsing or test environments may expose no writable storage.
    }
  }
  return id;
}

class MeshClient {
  private ws: WebSocket | null = null;
  private deviceId = getDeviceId();
  private label = this.buildLabel();
  private status: MeshStatus = "offline";
  private nodeCount = 0;
  private nodes: MeshNodeInfo[] = [];
  private reconnectDelay = 1_000;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private manualClosed = false;
  private meshToken: string | null = null;
  private tokenController: AbortController | null = null;
  private connectionGeneration = 0;
  private connecting = false;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();

  private buildLabel(): string {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return "هاتف أندرويد";
    if (/iphone|ipad|ipod/i.test(ua)) return "آيفون / آيباد";
    if (/windows/i.test(ua)) return "حاسوب ويندوز";
    if (/mac/i.test(ua)) return "حاسوب ماك";
    return "عقدة المرصد";
  }

  connect(): void {
    if (this.ws || this.reconnectTimer !== null || this.connecting) return;
    this.manualClosed = false;
    this.connecting = true;
    this.setStatus("connecting");
    void this.openSocket();
  }

  disconnect(): void {
    this.manualClosed = true;
    this.connectionGeneration++;
    this.connecting = false;
    this.tokenController?.abort();
    this.tokenController = null;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("offline");
  }

  private async fetchMeshToken(generation: number): Promise<string | null> {
    const controller = new AbortController();
    this.tokenController = controller;
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TOKEN_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/mesh/token?deviceId=${encodeURIComponent(this.deviceId)}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (generation !== this.connectionGeneration || this.manualClosed) return null;
      if (!res.ok) return null;
      const data = (await res.json()) as { token?: unknown };
      return typeof data.token === "string" && data.token.length > 0 ? data.token : null;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeout);
      if (this.tokenController === controller) this.tokenController = null;
    }
  }

  private async openSocket(): Promise<void> {
    const generation = ++this.connectionGeneration;
    if (this.manualClosed) return;
    if (!this.meshToken) {
      this.meshToken = await this.fetchMeshToken(generation);
    }
    if (generation !== this.connectionGeneration || this.manualClosed) {
      if (generation === this.connectionGeneration) this.connecting = false;
      return;
    }
    if (!this.meshToken) {
      this.connecting = false;
      this.setStatus("offline");
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.meshToken = null;
        this.connecting = true;
        void this.openSocket();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      return;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
    } catch {
      this.connecting = false;
      this.setStatus("offline");
      return;
    }
    this.connecting = false;
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || generation !== this.connectionGeneration || this.manualClosed) return;
      this.reconnectDelay = 1_000;
      ws.send(JSON.stringify({ type: "hello", deviceId: this.deviceId, label: this.label, token: this.meshToken }));
      if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "ping" }));
        }
      }, HEARTBEAT_MS);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || generation !== this.connectionGeneration || this.manualClosed) return;
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
    };

    ws.onclose = () => {
      if (this.ws !== ws || generation !== this.connectionGeneration) return;
      this.ws = null;
      this.meshToken = null; // token is short-lived; fetch a fresh one on reconnect
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (!this.manualClosed) {
        this.setStatus("offline");
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connecting = true;
          void this.openSocket();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws || generation !== this.connectionGeneration) return;
      // onclose will follow and schedule a reconnect
    };
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
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
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