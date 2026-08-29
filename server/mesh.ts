import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import logger from "./logger.js";
import { verifyMeshToken } from "./mesh-auth.js";
import { connectionKey } from "./live.js";

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
const MAX_NODES = 250;

// L6 fix: shape/bounds gates for relayed report traffic. Authenticated nodes
// could previously relay arbitrary report:new / report:confirm payloads to
// every client; the web layer validates locally, but the displayed consensus
// numbers could be briefly poisoned until the next HTTP refresh.
const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_STATUSES = new Set(["pending", "verified", "rejected", "resolved"]);

function isValidRelayedReport(report: unknown): boolean {
  if (!report || typeof report !== "object") return false;
  const r = report as Record<string, unknown>;
  // A relayed report must at least carry a bounded id. The mesh wire contract
  // allows metadata-light frames (e.g. {id, locationName}) — clients fetch
  // the full report over HTTP — so present fields are checked for sanity
  // instead of being required.
  if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 64) return false;
  if (r.lat !== undefined && (typeof r.lat !== "number" || !Number.isFinite(r.lat) || r.lat < -90 || r.lat > 90)) return false;
  if (r.lng !== undefined && (typeof r.lng !== "number" || !Number.isFinite(r.lng) || r.lng < -180 || r.lng > 180)) return false;
  if (r.description !== undefined && (typeof r.description !== "string" || r.description.length > 2000)) return false;
  if (r.wilaya !== undefined && (typeof r.wilaya !== "string" || r.wilaya.length > 200)) return false;
  if (r.severity !== undefined && !VALID_SEVERITIES.has(String(r.severity))) return false;
  if (r.status !== undefined && !VALID_STATUSES.has(String(r.status))) return false;
  return true;
}

function isValidRelayedConfirm(message: MeshMessage): boolean {
  const { id, consensusCount, status } = message;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return false;
  if (typeof consensusCount !== "number" || !Number.isFinite(consensusCount) || consensusCount < 0 || consensusCount > 1_000_000) return false;
  if (status !== undefined && !VALID_STATUSES.has(String(status))) return false;
  return true;
}
// C3 fix: the upgrade path must not be an unauthenticated resource drain.
// Mirror live.ts: cap connection attempts per IP per window, and close any
// socket that never completes a mesh hello.
const CONN_WINDOW_MS = 60 * 1000;
const MAX_CONNS_PER_IP = 10;
const AUTH_TIMEOUT_MS = 10_000;

class MeshHub {
  private wss: WebSocketServer | null = null;
  private nodes = new Map<string, MeshNode>();
  private connCount = new Map<string, { count: number; expiresAt: number }>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  attach(server: Server): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname !== MESH_PATH || !this.wss) return;

      // C3 fix: per-IP connection-attempt cap (same policy as live.ts).
      const ip = connectionKey(req);
      const now = Date.now();
      const entry = this.connCount.get(ip);
      if (!entry || now > entry.expiresAt) {
        this.connCount.set(ip, { count: 1, expiresAt: now + CONN_WINDOW_MS });
      } else {
        entry.count += 1;
        if (entry.count > MAX_CONNS_PER_IP) {
          logger.warn({ ip }, "Mesh upgrade rejected — connection limit reached");
          socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws, req) => {
      const ip = req.socket.remoteAddress || "unknown";
      let nodeId: string | null = null;

      // C3 fix: an unauthenticated socket must not be allowed to park forever.
      // If no mesh hello completed within the window, drop the connection.
      let authTimer: NodeJS.Timeout | null = setTimeout(() => {
        if (!nodeId) {
          logger.warn({ ip }, "Mesh auth timeout — closing unauthenticated socket");
          try { ws.close(4002, "Auth timeout"); } catch { /* ignore */ }
        }
      }, AUTH_TIMEOUT_MS);
      authTimer.unref();

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

          const token = String(message.authKey || message.token || "");
          const payload = verifyMeshToken(token);
          if (!payload || payload.deviceId !== deviceId) {
            logger.warn({ ip }, "Mesh hello rejected — invalid token");
            this.send(ws, { type: "error", message: "Unauthorized" });
            ws.close(4001, "Unauthorized");
            return;
          }

          const label = String(message.label || "Mesh Node").slice(0, 64);

          if (this.nodes.size >= MAX_NODES) {
            logger.warn({ ip, deviceId }, "Mesh node rejected — node limit reached");
            this.send(ws, { type: "error", message: "Node limit reached" });
            ws.close(4001, "Too many nodes");
            return;
          }

          const previous = this.nodes.get(deviceId);
          if (previous && previous.ws !== ws) {
            try { previous.ws.close(); } catch { /* ignore */ }
          }

          nodeId = deviceId;
          if (authTimer) { clearTimeout(authTimer); authTimer = null; }
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
            if (!isValidRelayedReport(message.report)) {
              logger.warn({ nodeId }, "Mesh relay rejected — invalid report payload");
              this.send(ws, { type: "error", message: "Invalid report payload" });
              break;
            }
            this.broadcast({ type: "report:new", report: message.report, from: nodeId }, nodeId);
            break;
          case "report:confirm":
            if (!isValidRelayedConfirm(message)) {
              logger.warn({ nodeId }, "Mesh relay rejected — invalid confirm payload");
              this.send(ws, { type: "error", message: "Invalid confirm payload" });
              break;
            }
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
        if (authTimer) { clearTimeout(authTimer); authTimer = null; }
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
      // C3 fix: sweep expired per-IP connection counters.
      for (const [k, v] of this.connCount) {
        if (now > v.expiresAt) this.connCount.delete(k);
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
