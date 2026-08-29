import { WebSocketServer, WebSocket } from "ws";
import { Server, IncomingMessage } from "http";
import logger from "./logger.js";
import config from "./config.js";

const LIVE_PATH = "/api/live";
const CONN_WINDOW_MS = 60 * 1000;
const MAX_CONNS_PER_IP = 10;

// Browsers send an Origin header on the WS upgrade; native apps do not.
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  // L4 fix: the scheme was stripped before host comparison, so an insecure
  // ws:// origin could match the production host. Browser origins on a
  // production deployment must be https/wss only.
  if (config.nodeEnv === "production" && /^(ws|http):\/\//i.test(origin)) return false;
  if (config.corsOrigins.includes(origin)) return true;
  const host = origin.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const appHost = config.appUrl.replace(/^https?:\/\//, "");
  return appHost !== "" && appHost === host;
}

/**
 * Express is configured for one trusted reverse-proxy hop. Such a proxy appends
 * the immediate client address to the right of X-Forwarded-For; a client can
 * prepend arbitrary values. Taking the right-most forwarded value therefore
 * avoids keying this limiter by a spoofable left-most value.
 */
export function connectionKey(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const entries = forwarded.split(",").map((value) => value.trim()).filter(Boolean);
    const clientIp = entries.at(-1);
    if (clientIp) return clientIp;
  }
  return req.socket.remoteAddress || "unknown";
}

class LiveHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private connCount = new Map<string, { count: number; expiresAt: number }>();

  attach(server: Server): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname !== LIVE_PATH || !this.wss) return;

      if (!originAllowed(req.headers.origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const ip = connectionKey(req);
      const now = Date.now();
      const entry = this.connCount.get(ip);
      if (!entry || now > entry.expiresAt) {
        this.connCount.set(ip, { count: 1, expiresAt: now + CONN_WINDOW_MS });
      } else {
        entry.count += 1;
        if (entry.count > MAX_CONNS_PER_IP) {
          socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", (err) => logger.warn({ err }, "Live socket error"));
    });

    const sweep = () => {
      const now = Date.now();
      for (const [k, v] of this.connCount) if (now > v.expiresAt) this.connCount.delete(k);
    };
    setInterval(sweep, CONN_WINDOW_MS).unref();

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
