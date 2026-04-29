import type { WorkspaceClient } from "@databricks/sdk-experimental";
import {
  type AppkitLog,
  buildAppkitPayload,
  type TelemetryPayload,
} from "./appkit-log.js";
import { postTelemetry, type TelemetrySendResult } from "./client.js";

interface SendOptions {
  workspaceHost: string;
  workspaceId: string;
  client: WorkspaceClient;
}

/**
 * Send a batch of AppkitLog events to the Databricks Client Telemetry endpoint.
 * Returns null when there is nothing to send. Errors propagate to the caller —
 * silencing happens at the SDK's outermost boundary (fire-and-forget startup
 * + periodic timers), not here, so consumers like the dev-playground can see
 * exactly what was sent and how the endpoint responded.
 */
export async function sendAppkitLogs(
  logs: AppkitLog[],
  opts: SendOptions,
): Promise<TelemetrySendResult | null> {
  if (logs.length === 0) return null;
  return postTelemetry({ ...opts, payload: buildAppkitPayload(logs) });
}

interface StartupTelemetryParams extends SendOptions {
  appkitVersion: string;
  appName: string;
  plugins: string[];
  environment: string;
}

function buildEntityId(params: StartupTelemetryParams): string {
  const plugins = params.plugins.join(",");
  return `appkit:${params.appkitVersion}:${params.environment}:${plugins}`;
}

function buildLegacyStartupPayload(
  params: StartupTelemetryParams,
): TelemetryPayload {
  const now = Date.now();
  const protoLog = {
    frontend_log_event_id: `appkit-startup-${crypto.randomUUID()}`,
    inferred_timestamp_millis: now,
    entry: {
      observability_log: {
        type: "INTERACTION_PHASE",
        entity: {
          type: "INTERACTION",
          sub_type: "INITIAL_LOAD",
          entity_id: buildEntityId(params),
        },
        client_source: "APPKIT",
      },
    },
  };
  return { uploadTime: now, items: [], protoLogs: [JSON.stringify(protoLog)] };
}

/**
 * Sends a single APP_STARTUP telemetry event using the legacy observability_log
 * format. Kept as a fallback while the AppkitLog schema is being deployed to
 * the telemetry backend; remove once AppkitLog is GA'd.
 */
export async function sendStartupTelemetry(
  params: StartupTelemetryParams,
): Promise<TelemetrySendResult> {
  return postTelemetry({
    workspaceHost: params.workspaceHost,
    workspaceId: params.workspaceId,
    client: params.client,
    payload: buildLegacyStartupPayload(params),
  });
}
