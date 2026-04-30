import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { type AppkitLog, buildAppkitPayload } from "./appkit-log.js";
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
