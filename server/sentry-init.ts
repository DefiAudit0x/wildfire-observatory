import * as Sentry from "@sentry/node";
import config from "./config.js";
import { scrubSentryEvent } from "./sentry-scrub.js";

Sentry.init({
  dsn: config.sentryDsn,
  environment: config.nodeEnv,
  tracesSampleRate: config.nodeEnv === "production" ? 0.1 : 0,
  integrations: [Sentry.expressIntegration()],
  beforeSend: (event) => scrubSentryEvent(event),
});