import type { TelemetryOptions } from "shared";

export interface TelemetryProviderConfig {
  traces: boolean;
  metrics: boolean;
  logs: boolean;
}

export function normalizeTelemetryOptions(
  config: TelemetryOptions = {},
): TelemetryProviderConfig {
  return {
    traces: config.traces ?? true,
    metrics: config.metrics ?? true,
    logs: config.logs ?? true,
  };
}
