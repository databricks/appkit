import { ApiError, type WorkspaceClient } from "@databricks/sdk-experimental";
import { createLogger } from "../../logging/logger";
import type { ServingInvokeOptions } from "./types";

const logger = createLogger("connectors:serving");

/**
 * Builds the invocation URL for a serving endpoint.
 * Uses `/served-models/{model}/invocations` when servedModel is specified,
 * otherwise `/serving-endpoints/{name}/invocations`.
 */
function buildInvocationUrl(
  host: string,
  endpointName: string,
  servedModel?: string,
): string {
  const base = host.startsWith("http") ? host : `https://${host}`;
  const encodedName = encodeURIComponent(endpointName);
  const path = servedModel
    ? `/serving-endpoints/${encodedName}/served-models/${encodeURIComponent(servedModel)}/invocations`
    : `/serving-endpoints/${encodedName}/invocations`;
  return new URL(path, base).toString();
}

/**
 * Maps upstream Databricks error status codes to appropriate proxy responses.
 */
function mapUpstreamError(
  status: number,
  body: string,
  headers: Headers,
): ApiError {
  const safeMessage = body.length > 500 ? `${body.slice(0, 500)}...` : body;

  let parsed: { message?: string; error?: string } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // body is not JSON
  }

  const message = parsed.message || parsed.error || safeMessage;

  switch (true) {
    case status === 400:
      return new ApiError(message, "BAD_REQUEST", 400, undefined, []);
    case status === 401 || status === 403:
      logger.warn("Authentication failure from serving endpoint: %s", message);
      return new ApiError(message, "AUTH_FAILURE", status, undefined, []);
    case status === 404:
      return new ApiError(message, "NOT_FOUND", 404, undefined, []);
    case status === 429: {
      const retryAfter = headers.get("retry-after");
      const retryMessage = retryAfter
        ? `${message} (retry-after: ${retryAfter})`
        : message;
      return new ApiError(retryMessage, "RATE_LIMITED", 429, undefined, []);
    }
    case status === 503:
      return new ApiError(
        "Endpoint loading, retry shortly",
        "SERVICE_UNAVAILABLE",
        503,
        undefined,
        [],
      );
    case status >= 500:
      return new ApiError(message, "BAD_GATEWAY", 502, undefined, []);
    default:
      return new ApiError(message, "UNKNOWN", status, undefined, []);
  }
}

/**
 * Invokes a serving endpoint and returns the parsed JSON response.
 */
export async function invoke(
  client: WorkspaceClient,
  endpointName: string,
  body: Record<string, unknown>,
  options?: ServingInvokeOptions,
): Promise<unknown> {
  const host = client.config.host;
  if (!host) {
    throw new Error(
      "Databricks host is not configured. Set DATABRICKS_HOST or configure client.config.host.",
    );
  }

  const url = buildInvocationUrl(host, endpointName, options?.servedModel);

  // Always strip `stream` from the body — the connector controls this
  const { stream: _stream, ...cleanBody } = body;

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  await client.config.authenticate(headers);

  logger.debug("Invoking endpoint %s at %s", endpointName, url);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(cleanBody),
    signal: options?.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw mapUpstreamError(res.status, text, res.headers);
  }

  return res.json();
}

/**
 * Invokes a serving endpoint with streaming enabled.
 * Yields parsed JSON chunks from the NDJSON SSE response.
 */
export async function* stream(
  client: WorkspaceClient,
  endpointName: string,
  body: Record<string, unknown>,
  options?: ServingInvokeOptions,
): AsyncGenerator<unknown> {
  const host = client.config.host;
  if (!host) {
    throw new Error(
      "Databricks host is not configured. Set DATABRICKS_HOST or configure client.config.host.",
    );
  }

  const url = buildInvocationUrl(host, endpointName, options?.servedModel);

  // Strip any user-provided `stream` and inject `stream: true`
  const { stream: _stream, ...cleanBody } = body;
  const streamBody = { ...cleanBody, stream: true };

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  });
  await client.config.authenticate(headers);

  logger.debug("Streaming from endpoint %s at %s", endpointName, url);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(streamBody),
    signal: options?.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw mapUpstreamError(res.status, text, res.headers);
  }

  if (!res.body) {
    throw new Error("Response body is null — streaming not supported");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (options?.signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines from the buffer
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // skip empty lines and SSE comments
        if (trimmed === "data: [DONE]") return;

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            yield JSON.parse(jsonStr);
          } catch {
            logger.warn("Failed to parse streaming chunk: %s", jsonStr);
          }
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim() && !options?.signal?.aborted) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
        try {
          yield JSON.parse(trimmed.slice(6));
        } catch {
          logger.warn("Failed to parse final streaming chunk: %s", trimmed);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
