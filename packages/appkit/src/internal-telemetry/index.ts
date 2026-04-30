// Internal telemetry: APP_STARTUP, HEARTBEAT, and REQUEST_METRICS events
// POSTed to /telemetry-ext so the Databricks team can prioritize SDK work.
// Disable with disableInternalTelemetry: true on createApp, or
// DISABLE_APPKIT_INTERNAL_TELEMETRY=true.
// Full data inventory: docs/docs/internal-telemetry.mdx.

export type {
  TelemetrySendRequest,
  TelemetrySendResponse,
  TelemetrySendResult,
} from "./client.js";
export { isInternalTelemetryEnabled } from "./config.js";
export { TelemetryReporter } from "./reporter.js";
