// Loaded with `node --import ./dist/instrumentation.js` before the app, so OpenTelemetry can patch modules.
// Tracing is on only when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise this file does nothing.
import { register } from "node:module";

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
