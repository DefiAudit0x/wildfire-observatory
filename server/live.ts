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
 * The raw upgrade path bypasses Express, so `trust proxy` never
 * applies here: X-Forwarded-For is honored ONLY when the immediate
 * peer is a trusted reverse proxy. In this deployment the proxy is
 * either local (loopback) or inside the platform's private network
 * (Render fronts the app with its own proxy); a direct client
 * arrives with a public socket address and must never control the
 * limiter key. Taking the right-most forwarded value is correct
 * ONLY behind that trusted hop — it stops a client spoofing the
 * left-most value, but trusting the header from an untrusted peer
 * would let a direct client pick ANY limiter key (rotate keys to
 * dodge the cap, or impersonate a victim's IP to get them capped).
 * The ranges are checked explicitly (RFC 1918): a library
 * "is private" predicate also matches documentation ranges.
 */
function isTrustedProxyPeer(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const parts = v4.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  if (a === 127) return true; // loopback 127/8
  if (a === 10) return true; // RFC 1918 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC 1918 192.168/16
  return false;
}

export function connectionKey(req: IncomingMessage): string {
  if (isTrustedProxyPeer(req.socket.remoteAddress)) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const entries = forwarded.split(",").map((value) => value.trim()).filter(Boolean);
      const clientIp = entries.at(-1);
      if (clientIp) return clientIp;
    }
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
