import "./sentry-init.js";
import * as Sentry from "@sentry/node";
import express from "express";
import path from "path";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import config from "./config.js";
import logger from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware.js";
import swaggerSpec from "./swagger.js";
import { meshHub, MESH_PATH } from "./mesh.js";
import { liveHub, LIVE_PATH } from "./live.js";
import { createMeshToken } from "./mesh-auth.js";
import { getPublicPrincipal, issuePublicPrincipal } from "./public-principal.js";
import { confirmReportWithPrincipal } from "./confirmation-ledger.js";
import { citizenReports } from "./data.js";

import { healthHandler } from "./routes/health.js";
import reportsRouter from "./routes/reports.js";
import adminRouter from "./routes/admin.js";
import satelliteRouter from "./routes/satellite.js";
import wilayasRouter from "./routes/wilayas.js";
import aiRouter from "./routes/ai.js";
import notificationsRouter from "./routes/notifications.js";
import sosRouter from "./routes/sos.js";
import badgesRouter from "./routes/badges.js";
import volunteersRouter from "./routes/volunteers.js";
import commandRouter from "./routes/command.js";
import auditRouter from "./routes/audit.js";
import safezonesRouter from "./routes/safezones.js";
import authRouter from "./routes/auth.js";
import unitsRouter from "./routes/units.js";
import usersRouter from "./routes/users.js";
import rosterRouter from "./routes/roster.js";
import historyRouter from "./routes/history.js";

const app = express();
app.set("trust proxy", 1);
const PORT = config.port;
const isProduction = config.nodeEnv === "production";

app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: isProduction ? ["'self'"] : ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "https:"],
  connectSrc: ["'self'", "wss:", "ws:", "https://firms.modaps.eosdis.nasa.gov", "https://*.basemaps.cartocdn.com", "https://tile.openstreetmap.org", "https://api.open-meteo.com", "https://router.project-osrm.org"],
  fontSrc: ["'self'", "data:"]
} } }));
app.use(cors({ origin: config.corsOrigins, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: config.generalLimitMax, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests, please try again later." }, skip: (req) => !req.path.startsWith("/api") });
app.use(generalLimiter);
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "AI guidance limit reached. Try again later." } });
app.use((req, _res, next) => { if (req.url.startsWith("//")) req.url = req.url.replace(/^\/+/, "/"); next(); });

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function hasSessionCookie(req: express.Request): boolean {
  return (req.headers.cookie || "").split(";").some((cookie) => {
    const name = cookie.trim().split("=", 1)[0];
    return name === "admin_token" || name === "staff_token" || name === "public_principal";
  });
}
function isTrustedOrigin(req: express.Request): boolean {
  const origin = req.headers.origin;
  if (origin) return config.corsOrigins.includes(origin) || origin === `${req.protocol}://${req.get("host")}`;
  const fetchSite = req.headers["sec-fetch-site"];
  return fetchSite === "same-origin" || fetchSite === "same-site";
}
function csrfProtection(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!MUTATING_METHODS.has(req.method) || req.headers.authorization || !hasSessionCookie(req)) return next();
  if (!isTrustedOrigin(req)) return void res.status(403).json({ error: "Forbidden: cross-origin state change rejected" });
  next();
}
app.use(csrfProtection);
app.use((req, _res, next) => { logger.info({ req }, "Request"); next(); });
if (!isProduction || process.env.ENABLE_SWAGGER === "true") app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));
app.get("/api/health", healthHandler);

const principalEnrollmentLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many principal enrollment requests" } });
app.post("/api/public-principal", principalEnrollmentLimiter, (req, res) => {
  const existing = getPublicPrincipal(req);
  if (existing) return void res.json({ subject: existing.subject });
  const principal = issuePublicPrincipal(res);
  res.status(201).json({ subject: principal.subject });
});

const meshTokenLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many mesh token requests" } });
app.get("/api/mesh/token", meshTokenLimiter, (req, res) => {
  const principal = getPublicPrincipal(req);
  if (!principal) return void res.status(401).json({ error: "Public principal required" });
  res.json({ token: createMeshToken(principal.subject) });
});

const confirmLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many confirmations. Slow down." } });
const localPrincipalVotes = new Map<string, Set<string>>();
app.post("/api/reports/:id/confirm", confirmLimiter, async (req, res) => {
  const principal = getPublicPrincipal(req);
  if (!principal) return void res.status(401).json({ error: "Public principal required" });
  const reportId = String(req.params.id || "");
  const result = await confirmReportWithPrincipal(reportId, principal.subject);
  if (result.status === "confirmed") {
    meshHub.broadcast({ type: "report:confirm", id: reportId, consensusCount: result.consensusCount, status: result.statusValue });
    return void res.json({ success: true, consensusCount: result.consensusCount, status: result.statusValue });
  }
  if (result.status === "already_voted") return void res.status(409).json({ error: "Already confirmed" });
  if (result.status === "not_found") return void res.status(404).json({ error: "Report not found" });
  if (result.status === "error") return void res.status(503).json({ code: "CONSENSUS_DURABILITY_UNAVAILABLE", error: "Confirmation persistence is currently unavailable" });

  // Local development only: the fallback ledger is still keyed exclusively by
  // the verified server-issued subject, never by IP or caller-selected deviceId.
  const report = citizenReports.find((item) => item.id === reportId);
  if (!report) return void res.status(404).json({ error: "Report not found" });
  const votes = localPrincipalVotes.get(reportId) ?? new Set<string>();
  if (votes.has(principal.subject)) return void res.status(409).json({ error: "Already confirmed" });
  votes.add(principal.subject);
  localPrincipalVotes.set(reportId, votes);
  report.consensusCount += 1;
  if (report.consensusCount >= 5 && report.status === "pending") report.status = "verified";
  meshHub.broadcast({ type: "report:confirm", id: reportId, consensusCount: report.consensusCount, status: report.status });
  res.json({ success: true, consensusCount: report.consensusCount, status: report.status });
});

app.use("/api/reports", reportsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/satellite-data", satelliteRouter);
app.use("/api/wilayas", wilayasRouter);
app.use("/api/ai/guidance", aiLimiter, aiRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/sos", sosRouter);
app.use("/api/badges", badgesRouter);
app.use("/api/volunteer", volunteersRouter);
app.use("/api/audit", auditRouter);
app.use("/api/safezones", safezonesRouter);
app.use("/api/auth", authRouter);
app.use("/api/units", unitsRouter);
app.use("/api/users", usersRouter);
app.use("/api/roster", rosterRouter);
app.use("/api/history", historyRouter);
app.use("/api", commandRouter);

async function startServer() {
  if (config.nodeEnv !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("/assets/*splat", (req, res) => {
      const assetPath = req.path.slice("/assets/".length);
      res.sendFile(assetPath, { root: distPath }, (err) => {
        if (!err || res.headersSent) return;
        logger.warn({ path: req.path, err: err.message }, "Asset not found");
        res.status(404).json({ error: "Asset not found" });
      });
    });
    app.get("/*splat", (req, res) => {
      if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
      res.sendFile("index.html", { root: distPath });
    });
  }
  app.use(notFoundHandler);
  if (config.sentryDsn) Sentry.setupExpressErrorHandler(app);
  app.use(errorHandler);
  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server running on http://0.0.0.0:${PORT}`);
    if (!isProduction || process.env.ENABLE_SWAGGER === "true") logger.info(`Swagger docs at http://localhost:${PORT}/api-docs`);
  });
  fetch("https://api.ipify.org").then((r) => r.text()).then((ip) => logger.info(`Egress IP: ${ip} — whitelist this IP on the NASA FIRMS account if FIRMS fails`)).catch((err) => logger.warn({ err }, "Could not determine egress IP"));
  meshHub.attach(httpServer);
  logger.info(`Mesh hub listening on ${MESH_PATH}`);
  liveHub.attach(httpServer);
  logger.info(`Live hub listening on ${LIVE_PATH}`);
}
startServer();
