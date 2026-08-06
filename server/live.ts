import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import logger from "./logger.js";

const LIVE_PATH = "/api/live";

class LiveHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  attach(server: Server): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname !== LIVE_PATH || !this.wss) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", (err) => logger.warn({ err }, "Live socket error"));
    });

    logger.info(`Live hub attached at ${LIVE_PATH}`);
  }

  broadcast(type: string, payload: Record<string, unknown> = {}): void {
    const message = JSON.stringify({ ts: Date.now(), type, ...payload });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (err) {
          logger.warn({ err }, "Live broadcast send failed");
        }
      }
    }
  }
}

export const liveHub = new LiveHub();
export { LIVE_PATH };
