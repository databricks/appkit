/**
 * Checks whether internal telemetry is enabled.
 * Shared across all telemetry event types (startup, heartbeat, metrics, etc.).
 */
export function isInternalTelemetryEnabled(opts?: {
  disableInternalTelemetry?: boolean;
}): boolean {
  if (opts?.disableInternalTelemetry) return false;
  if (process.env.APPKIT_TELEMETRY_DISABLED === "true") return false;
  return true;
}
