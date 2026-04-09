import type { serving } from "@databricks/sdk-experimental";
import { ApiError, type WorkspaceClient } from "@databricks/sdk-experimental";
import { createLogger } from "../../logging/logger";
import type { ServingStreamOptions } from "./types";

const logger = createLogger("connectors:serving");

/**
 * Maps upstream Databricks error status codes to appropriate proxy responses.
 * Used for raw API responses where the SDK doesn't handle errors automatically.
 */
function mapUpstreamError(status: number, body: string): ApiError {
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
    case status === 429:
      return new ApiError(message, "RATE_LIMITED", 429, undefined, []);
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
 * Invokes a serving endpoint using the SDK's high-level query API.
 * Returns a typed QueryEndpointResponse.
 */
export async function invoke(
  client: WorkspaceClient,
  endpointName: string,
  body: Record<string, unknown>,
): Promise<serving.QueryEndpointResponse> {
  // Strip `stream` from the body — the connector controls this
  const { stream: _stream, ...cleanBody } = body;

  logger.debug("Invoking endpoint %s", endpointName);

  return client.servingEndpoints.query({
    name: endpointName,
    ...cleanBody,
  } as serving.QueryEndpointInput);
}

/**
 * Invokes a serving endpoint with streaming enabled.
 * Yields parsed JSON chunks from the SSE response.
 *
 * Uses the SDK's low-level `apiClient.request({ raw: true })` because
 * the high-level `servingEndpoints.query()` returns `Promise<QueryEndpointResponse>`
 * and does not support SSE streaming.
 */
export async function* stream(
  client: WorkspaceClient,
  endpointName: string,
  body: Record<string, unknown>,
  options?: ServingStreamOptions,
): AsyncGenerator<unknown> {
  // Strip any user-provided `stream` and inject `stream: true`
  const { stream: _stream, ...cleanBody } = body;

  logger.debug("Streaming from endpoint %s", endpointName);

  const response = (await client.apiClient.request({
    path: `/serving-endpoints/${encodeURIComponent(endpointName)}/invocations`,
    method: "POST",
    headers: new Headers({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    }),
    payload: { ...cleanBody, stream: true },
    raw: true,
  })) as { contents: ReadableStream<Uint8Array> };

  if (!response.contents) {
    throw new Error("Response body is null — streaming not supported");
  }

  const reader = response.contents.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MB

  try {
    while (true) {
      if (options?.signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (buffer.length > MAX_BUFFER_SIZE) {
        throw new Error(
          `Stream buffer exceeded ${MAX_BUFFER_SIZE} bytes — possible non-SSE response`,
        );
      }

      // Process complete lines from the buffer
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        // Per SSE spec: empty lines are event delimiters,
        // lines starting with ":" are comments (often used as heartbeats).
        if (!trimmed || trimmed.startsWith(":")) continue;
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
    if (options?.signal?.aborted) {
      reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
