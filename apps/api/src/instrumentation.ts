// Loaded with `node --import ./dist/instrumentation.js` before the app, so OpenTelemetry can patch modules.
// Tracing and metrics are on only when OTEL_EXPORTER_OTLP_ENDPOINT is set, error reporting only when SENTRY_DSN is.
import { register } from "node:module";

if (process.env.SENTRY_DSN) {
  const Sentry = await import("@sentry/node");
  // Errors only: OpenTelemetry below does tracing, and no request data is sent (it may hold personal data).
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.DEPLOY_ENV ?? "local",
    release: process.env.RELEASE,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),
    ],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
  });
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "gym-api",
    instrumentations: [
      getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } }),
    ],
  });
  sdk.start();
  process.once("SIGTERM", () => void sdk.shutdown());
}
