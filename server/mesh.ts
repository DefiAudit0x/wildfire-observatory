import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import logger from "./logger.js";

export interface MeshNodeInfo {
  id: string;
  label: string;
  lastSeen: number;
}

interface MeshNode extends MeshNodeInfo {
  ws: WebSocket;
}

export interface MeshMessage {
  type: string;
  [key: string]: unknown;
}

const MESH_PATH = "/ws";
const HEARTBEAT_MS = 30_000;
const STALE_NODE_MS = 90_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

class MeshHub {
  private wss: WebSocketServer | null = null;
  private nodes = new Map<string, MeshNode>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  attach(server: Server): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname !== MESH_PATH || !this.wss) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws, req) => {
      const ip = req.socket.remoteAddress || "unknown";
      let nodeId: string | null = null;

      ws.on("message", (raw) => {
        let message: MeshMessage;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          this.send(ws, { type: "error", message: "Invalid JSON" });
          return;
        }

        if (message.type === "hello") {
          const deviceId = String(message.deviceId || "");
          if (!deviceId || deviceId.length > 128) {
            this.send(ws, { type: "error", message: "Invalid deviceId" });
            return;
          }
          const label = String(message.label || "Mesh Node").slice(0, 64);

          const previous = this.nodes.get(deviceId);
          if (previous && previous.ws !== ws) {
            try { previous.ws.close(); } catch { /* ignore */ }
          }

          nodeId = deviceId;
          this.nodes.set(deviceId, { id: deviceId, label, lastSeen: Date.now(), ws });
          logger.info({ deviceId, ip, nodeCount: this.nodes.size }, "Mesh node joined");

          this.send(ws, {
            type: "welcome",
            deviceId,
            nodeCount: this.nodes.size,
            nodes: this.getNodeInfos(),
          });
          this.broadcast({ type: "node:joined", node: { id: deviceId, label }, nodeCount: this.nodes.size }, deviceId);
          return;
        }

        if (!nodeId) {
          this.send(ws, { type: "error", message: "Send hello first" });
          return;
        }

        const node = this.nodes.get(nodeId);
        if (!node) return;
        node.lastSeen = Date.now();

        switch (message.type) {
          case "ping":
            this.send(ws, { type: "pong", at: Date.now() });
            break;
          case "report:new":
            this.broadcast({ type: "report:new", report: message.report, from: nodeId }, nodeId);
            break;
          case "report:confirm":
            this.broadcast({
              type: "report:confirm",
              id: message.id,
              consensusCount: message.consensusCount,
              status: message.status,
              from: nodeId,
            }, nodeId);
            break;
          default:
            this.send(ws, { type: "error", message: `Unknown message type: ${message.type}` });
        }
      });

      ws.on("close", () => {
        if (nodeId && this.nodes.get(nodeId)?.ws === ws) {
          this.nodes.delete(nodeId);
          logger.info({ nodeId, nodeCount: this.nodes.size }, "Mesh node left");
          this.broadcast({ type: "node:left", nodeId, nodeCount: this.nodes.size });
        }
      });

      ws.on("error", (err) => {
        logger.warn({ err, ip }, "Mesh socket error");
      });
    });

    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, node] of this.nodes) {
        if (now - node.lastSeen > STALE_NODE_MS) {
          try { node.ws.close(); } catch { /* ignore */ }
          this.nodes.delete(id);
          logger.info({ nodeId: id, nodeCount: this.nodes.size }, "Mesh node removed (stale)");
          this.broadcast({ type: "node:left", nodeId: id, nodeCount: this.nodes.size });
        }
      }
    }, HEARTBEAT_MS);
    this.cleanupTimer.unref();

    logger.info("Mesh hub attached at /ws");
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  getNodeInfos(): MeshNodeInfo[] {
    return Array.from(this.nodes.values()).map(({ id, label, lastSeen }) => ({ id, label, lastSeen }));
  }

  broadcast(message: MeshMessage, excludeNodeId?: string): void {
    const payload = JSON.stringify({ ts: Date.now(), ...message });
    for (const [id, node] of this.nodes) {
      if (excludeNodeId && id === excludeNodeId) continue;
      if (node.ws.readyState === WebSocket.OPEN) {
        node.ws.send(payload);
      }
    }
  }

  private send(ws: WebSocket, message: MeshMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ts: Date.now(), ...message }));
    }
  }
}

export const meshHub = new MeshHub();
export { MESH_PATH };
