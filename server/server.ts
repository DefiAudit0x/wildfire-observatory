import * as Sentry from "@sentry/node";
import express from "express";
import path from "path";
import fs from "fs";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import swaggerUi from "swagger-ui-express";
import config from "./config.js";
import logger from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware.js";
import swaggerSpec from "./swagger.js";
import { meshHub, MESH_PATH } from "./mesh.js";

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

const app = express();
// Railway runs a single load-balancer hop in front of the app container.
// "trust proxy 1" lets req.ip resolve to the real client IP (used for vote dedup).
app.set("trust proxy", 1);
const PORT = config.port;

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.nodeEnv === "production" ? 0.1 : 0,
    integrations: [Sentry.expressIntegration()],
  });
}

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

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
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

app.use((req, _res, next) => {
  logger.info({ req }, "Request");
  next();
});

if (!isProduction || process.env.ENABLE_SWAGGER === "true") {
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));
}

app.get("/api/health", healthHandler);
app.use("/api/reports", reportsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/satellite-data", satelliteRouter);
app.use("/api/wilayas", wilayasRouter);
app.use("/api/ai/guidance", aiLimiter, aiRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/sos", sosRouter);
app.use("/api/badges", badgesRouter);
app.use("/api/volunteer", volunteersRouter);
app.use("/api", commandRouter);

async function startServer() {
  if (config.nodeEnv !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));

    app.get("/assets/*", (req, res) => {
      const filePath = path.join(distPath, req.path);
      if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
      } else {
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

  meshHub.attach(httpServer);
  logger.info(`Mesh hub listening on ${MESH_PATH}`);
}

startServer();
