import pino from "pino";
import config from "./config.js";

const logger = pino({
  level: config.logLevel,
  transport: config.nodeEnv !== "production"
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined,
  serializers: {
    req: (r) => ({ method: r.method, url: r.url, ip: r.ip }),
    res: (r) => ({ statusCode: r.statusCode }),
    err: pino.stdSerializers.err,
  },
});

export default logger;
