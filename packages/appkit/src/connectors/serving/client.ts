import type { serving, WorkspaceClient } from "@databricks/sdk-experimental";
import { createLogger } from "../../logging/logger";

const logger = createLogger("connectors:serving");

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
 * Returns the raw SSE byte stream from a serving endpoint.
 * No parsing is performed — bytes are passed through as-is.
 *
 * Uses the SDK's low-level `apiClient.request({ raw: true })` because
 * the high-level `servingEndpoints.query()` returns `Promise<QueryEndpointResponse>`
 * and does not support SSE streaming.
 */
export async function stream(
  client: WorkspaceClient,
  endpointName: string,
  body: Record<string, unknown>,
): Promise<ReadableStream<Uint8Array>> {
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

  return response.contents;
}
