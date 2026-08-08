import "./sentry-init.js";
import * as Sentry from "@sentry/node";
import express from "express";
import path from "path";
import fs from "fs";
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

const app = express();
// Railway runs a single load-balancer hop in front of the app container.
// "trust proxy 1" lets req.ip resolve to the real client IP (used for vote dedup).
app.set("trust proxy", 1);
const PORT = config.port;

const isProduction = config.nodeEnv === "production";

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: isProduction ? ["'self'"] : ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: [
        "'self'",
        "wss:",
        "ws:",
        "https://firms.modaps.eosdis.nasa.gov",
        "https://*.basemaps.cartocdn.com",
        "https://tile.openstreetmap.org",
        "https://api.open-meteo.com",
        "https://router.project-osrm.org",
      ],
      fontSrc: ["'self'", "data:"],
    },
  },
}));

app.use(cors({
  origin: config.corsOrigins,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.generalLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => !req.path.startsWith("/api"),
});
app.use(generalLimiter);

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "AI guidance limit reached. Try again later." },
});

app.use((req, _res, next) => {
  if (req.url.startsWith("//")) {
    req.url = req.url.replace(/^\/+/, "/");
  }
  next();
});

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isSameOriginRequest(req: express.Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  const forwardedProto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host;
  if (host) {
    const expected = `${forwardedProto}://${host}`;
    if (origin === expected) return true;
    const wsOrigin = `${forwardedProto === "https" ? "https" : "http"}://${host}`;
    if (origin === wsOrigin) return true;
  }
  return false;
}

app.use((req, res, next) => {
  if (MUTATING_METHODS.has(req.method) && !isSameOriginRequest(req) && !req.headers.authorization) {
    res.status(403).json({ error: "Forbidden: cross-origin state change rejected" });
    return;
  }
  next();
});

app.use((req, _res, next) => {
  logger.info({ req }, "Request");
  next();
});

if (!isProduction || process.env.ENABLE_SWAGGER === "true") {
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));
}

app.get("/api/health", healthHandler);

const meshTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many mesh token requests" },
});

app.get("/api/mesh/token", meshTokenLimiter, (req, res) => {
  const { deviceId } = req.query;
  if (typeof deviceId !== "string" || !deviceId || deviceId.length > 128) {
    res.status(400).json({ error: "Invalid deviceId" });
    return;
  }
  res.json({ token: createMeshToken(deviceId) });
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
app.use("/api", commandRouter);

async function startServer() {
  if (config.nodeEnv !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));

    app.get("/assets/*", async (req, res) => {
      const filePath = path.join(distPath, req.path);
      try {
        await fs.promises.access(filePath, fs.constants.R_OK);
        res.sendFile(filePath);
      } catch {
        logger.warn({ path: req.path }, "Asset not found");
        res.status(404).json({ error: "Asset not found" });
      }
    });

    app.get("*", (req, res) => {
      if (req.path.startsWith("/api/")) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use(notFoundHandler);

  if (config.sentryDsn) {
    Sentry.setupExpressErrorHandler(app);
  }
  app.use(errorHandler);

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server running on http://0.0.0.0:${PORT}`);
    if (!isProduction || process.env.ENABLE_SWAGGER === "true") {
      logger.info(`Swagger docs at http://localhost:${PORT}/api-docs`);
    }
  });

  fetch("https://api.ipify.org")
    .then((r) => r.text())
    .then((ip) => logger.info(`Egress IP: ${ip} — whitelist this IP on the NASA FIRMS account if FIRMS fails`))
    .catch((err) => logger.warn({ err }, "Could not determine egress IP"));

  meshHub.attach(httpServer);
  logger.info(`Mesh hub listening on ${MESH_PATH}`);
  liveHub.attach(httpServer);
  logger.info(`Live hub listening on ${LIVE_PATH}`);
}

startServer();
