// Internal telemetry: APP_STARTUP, HEARTBEAT, and REQUEST_METRICS events
// POSTed to /telemetry-ext so the Databricks team can prioritize SDK work.
// Disable with disableInternalTelemetry: true on createApp,
// DISABLE_APPKIT_INTERNAL_TELEMETRY=true, or DO_NOT_TRACK=1.
// Full data inventory: docs/docs/privacy.mdx.

export { isInternalTelemetryEnabled } from "./config";
export { TelemetryReporter } from "./reporter";
