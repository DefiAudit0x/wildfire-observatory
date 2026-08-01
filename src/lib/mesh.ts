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
const MAX_RECONNECT_DELAY_MS = 30_000;

function getDeviceId(): string {
  const KEY = "mesh_device_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `dev-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, id);
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
    if (this.ws || this.reconnectTimer !== null) return;
    this.manualClosed = false;
    this.setStatus("connecting");
    this.openSocket();
  }

  disconnect(): void {
    this.manualClosed = true;
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

  private openSocket(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1_000;
      ws.send(JSON.stringify({ type: "hello", deviceId: this.deviceId, label: this.label }));
      if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "ping" }));
        }
      }, HEARTBEAT_MS);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as MeshMessage;
        if (message.type === "welcome") {
          this.nodeCount = Number(message.nodeCount ?? 0);
          this.nodes = (message.nodes as MeshNodeInfo[]) || [];
          this.setStatus("online");
        } else if (message.type === "node:joined") {
          this.nodeCount = Number(message.nodeCount ?? this.nodeCount);
          const node = message.node as MeshNodeInfo;
          if (node) this.nodes = [...this.nodes.filter((n) => n.id !== node.id), node];
          this.emitStatus();
        } else if (message.type === "node:left") {
          this.nodeCount = Number(message.nodeCount ?? this.nodeCount);
          this.nodes = this.nodes.filter((n) => n.id !== message.nodeId);
          this.emitStatus();
        } else if (message.type === "error") {
          // Log only; connection stays alive
        }
        this.messageHandlers.forEach((handler) => handler(message));
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (!this.manualClosed) {
        this.setStatus("offline");
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.openSocket();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      // onclose will follow and schedule a reconnect
    };
  }

  private setStatus(status: MeshStatus): void {
    this.status = status;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.statusHandlers.forEach((handler) => handler(this.status, this.nodeCount, this.nodes));
  }

  send(message: MeshMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
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

export const meshClient = new MeshClient();
