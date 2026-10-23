import pino from "pino";
import config from "./config.js";

const logger = pino({
  level: config.logLevel,
  transport: config.nodeEnv !== "production"
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined,
  serializers: {
    // Query parameters can contain email verification and unsubscribe bearer
    // tokens. Keep request-path observability while excluding query strings.
    req: (r) => ({
      method: r.method,
      url: typeof r.url === "string" ? r.url.split("?", 1)[0] : undefined,
      ip: r.ip,
    }),
    res: (r) => ({ statusCode: r.statusCode }),
    err: pino.stdSerializers.err,
  },
});

export default logger;
