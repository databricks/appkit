import type { TelemetryOptions } from "shared";

export interface TelemetryProviderConfig {
  traces: boolean;
  metrics: boolean;
  logs: boolean;
}

export function normalizeTelemetryOptions(
  config?: TelemetryOptions,
): TelemetryProviderConfig {
  if (typeof config === "undefined" || typeof config === "boolean") {
    const value = config ?? true;
    return {
      traces: value,
      metrics: value,
      logs: value,
    };
  }

  return {
    traces: config?.traces ?? true,
    metrics: config?.metrics ?? true,
    logs: config?.logs ?? true,
  };
}
