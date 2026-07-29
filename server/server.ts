import * as Sentry from "@sentry/node";
import express from "express";
import path from "path";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import swaggerUi from "swagger-ui-express";
import config from "./config.js";
import logger from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware.js";
import swaggerSpec from "./swagger.js";

import { healthHandler } from "./routes/health.js";
import reportsRouter from "./routes/reports.js";
import adminRouter from "./routes/admin.js";
import satelliteRouter from "./routes/satellite.js";
import wilayasRouter from "./routes/wilayas.js";
import aiRouter from "./routes/ai.js";

const app = express();
const PORT = config.port;

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.nodeEnv === "production" ? 0.1 : 0,
    integrations: [Sentry.expressIntegration()],
  });
}

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
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

app.use((req, _res, next) => {
  logger.info({ req }, "Request");
  next();
});

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));

app.get("/api/health", healthHandler);
app.use("/api/reports", reportsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/satellite-data", satelliteRouter);
app.use("/api/wilayas", wilayasRouter);
app.use("/api/ai/guidance", aiRouter);

app.use(notFoundHandler);

if (config.sentryDsn) {
  Sentry.setupExpressErrorHandler(app);
}
app.use(errorHandler);

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
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server running on http://0.0.0.0:${PORT}`);
    logger.info(`Swagger docs at http://localhost:${PORT}/api-docs`);
  });
}

startServer();
