import type { WorkspaceClient } from "@databricks/sdk-experimental";

const TIMEOUT_MS = 10_000;

export interface TelemetrySendRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface TelemetrySendResponse {
  status: number;
  statusText: string;
  body: string;
}

export interface TelemetrySendResult {
  request: TelemetrySendRequest;
  response: TelemetrySendResponse;
}

function normalizeHost(rawHost: string): string {
  const host = rawHost.replace(/\/+$/, "");
  if (!host) return "";
  return host.startsWith("http") ? host : `https://${host}`;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function fetchWithRedirect(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(url, init);
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    return fetch(location, init);
  }
  return res;
}

/**
 * Authenticated POST to the Databricks Client Telemetry endpoint.
 * Returns the dispatched request and the received response so callers can
 * surface them for debugging. Throws on network, auth, or misconfiguration
 * errors; HTTP-level failures (4xx/5xx) are returned as-is on `response`.
 */
export async function postTelemetry(params: {
  workspaceHost: string;
  workspaceId: string;
  client: WorkspaceClient;
  payload: object;
}): Promise<TelemetrySendResult> {
  const host = normalizeHost(params.workspaceHost);
  if (!host) throw new Error("Telemetry: workspaceHost is empty");
  if (!params.workspaceId) throw new Error("Telemetry: workspaceId is empty");

  const url = `${host}/telemetry?o=${params.workspaceId}`;
  const body = JSON.stringify(params.payload);

  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Databricks-Org-Id": params.workspaceId,
  });
  await params.client.config.authenticate(headers);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const init: RequestInit = {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    };
    const response = await fetchWithRedirect(url, init);
    const responseBody = await response.text();
    return {
      request: { url, method: "POST", headers: headersToObject(headers), body },
      response: {
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
