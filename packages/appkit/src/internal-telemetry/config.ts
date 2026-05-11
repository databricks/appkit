/**
 * Checks whether internal telemetry is enabled.
 * Shared across all telemetry event types (startup, heartbeat, metrics, etc.).
 */
export function isInternalTelemetryEnabled(opts?: {
  disableInternalTelemetry?: boolean;
}): boolean {
  if (opts?.disableInternalTelemetry) return false;
  if (process.env.DISABLE_APPKIT_INTERNAL_TELEMETRY === "true") return false;
  if (process.env.DO_NOT_TRACK === "1") return false;
  return true;
}
