import { createLogger } from "../../logging/logger";
import type { serving, WorkspaceClient } from "../../workspace-client";
import { contextFromAbortSignal } from "../context";

const logger = createLogger("connectors:serving");

/**
 * Structural shape of a Databricks SDK client we need for the low-level
 * `apiClient.request` call. Lets `streamPath` be reused by adapters that
 * don't want a hard dependency on the concrete `WorkspaceClient` type.
 */
export interface ApiClientLike {
  apiClient: {
    request(
      options: Record<string, unknown>,
      context?: unknown,
    ): Promise<unknown>;
  };
}

/**
 * Transport shim shared by the agent adapters: given a request body, returns
 * the raw SSE byte stream from a serving / AI-gateway endpoint. Injected at
 * adapter construction time so callers can swap in the workspace SDK (the
 * factory paths via {@link streamPath}), a bare `fetch` (a reverse proxy /
 * mock), or a test fake.
 */
export type StreamBody = (
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;

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
 * POSTs `body` as JSON to an arbitrary workspace API path and returns the raw
 * SSE byte stream. No parsing is performed — bytes are passed through as-is.
 *
 * Uses the SDK's low-level `apiClient.request({ raw: true })` so callers
 * inherit URL resolution, the SDK credential chain (PAT/OAuth/OIDC), and
 * any future retries/telemetry baked into the SDK transport.
 *
 * When `signal` is provided it is bridged to the SDK's `Context` /
 * `CancellationToken` so aborts cancel the outbound HTTP request.
 *
 * @internal
 *
 * Not part of the public AppKit surface. `path` is passed through to the
 * SDK without any allowlist — exposing this to user-controlled input would
 * turn it into workspace-credentialled SSRF (CWE-918). Internal callers
 * must hard-code the path (or build it from a closed enum). New callers
 * inside the package: keep this constraint, and do not re-export from
 * `beta.ts` or any other entry point.
 */
export async function streamPath(
  client: ApiClientLike,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  logger.debug("Streaming from path %s", path);

  const context = contextFromAbortSignal(signal);

  const response = (await client.apiClient.request(
    {
      path,
      method: "POST",
      headers: new Headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      }),
      payload: body,
      raw: true,
    },
    context,
  )) as { contents: ReadableStream<Uint8Array> | null };

  if (!response.contents) {
    throw new Error("Response body is null — streaming not supported");
  }

  return response.contents;
}

/**
 * Returns the raw SSE byte stream from a serving endpoint. Thin wrapper over
 * {@link streamPath} that handles serving-specific URL encoding and forces
 * `stream: true` in the payload.
 */
export async function stream(
  client: WorkspaceClient,
  endpointName: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const { stream: _stream, ...cleanBody } = body;
  return streamPath(
    client as unknown as ApiClientLike,
    `/serving-endpoints/${encodeURIComponent(endpointName)}/invocations`,
    { ...cleanBody, stream: true },
    signal,
  );
}
