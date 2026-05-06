// IMPORTANT: keep this file in sync with the AppkitLog proto schema served by
// the Databricks client telemetry endpoint. Field names use proto JSON
// conventions (snake_case) so the wire format matches the backend.

export type AppkitEventName =
  | "APPKIT_EVENT_NAME_UNSPECIFIED"
  | "APP_STARTUP"
  | "HEARTBEAT"
  | "REQUEST_METRICS";

export type AppStartupEvent = Record<string, never>;

export type HeartbeatEvent = Record<string, never>;

export interface RequestMetricsEvent {
  endpoint?: string;
  request_count?: number;
  request_latency_ms_avg?: number;
  response_count_http4xx?: number;
  response_count_http5xx?: number;
}

export interface AppkitLog {
  event_name: AppkitEventName;
  app_id?: string;
  appkit_version?: string;
  app_startup_event?: AppStartupEvent;
  heartbeat_event?: HeartbeatEvent;
  request_metrics_event?: RequestMetricsEvent;
}

interface AppkitLogEnvelope {
  frontend_log_event_id: string;
  inferred_timestamp_millis: number;
  entry: { appkit_log: AppkitLog };
}

interface TelemetryPayload {
  uploadTime: number;
  items: never[];
  protoLogs: string[];
}

export function wrapAppkitLog(log: AppkitLog): AppkitLogEnvelope {
  return {
    frontend_log_event_id: `appkit-${log.event_name.toLowerCase()}-${crypto.randomUUID()}`,
    inferred_timestamp_millis: Date.now(),
    entry: { appkit_log: log },
  };
}

export function buildAppkitPayload(logs: AppkitLog[]): TelemetryPayload {
  return {
    uploadTime: Date.now(),
    items: [],
    protoLogs: logs.map((log) => JSON.stringify(wrapAppkitLog(log))),
  };
}
