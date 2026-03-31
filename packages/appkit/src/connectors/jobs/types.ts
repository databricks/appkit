import type { TelemetryOptions } from "shared";

export interface JobsConnectorConfig {
  timeout?: number;
  telemetry?: TelemetryOptions;
}
