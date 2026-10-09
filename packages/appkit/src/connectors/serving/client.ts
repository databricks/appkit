import { createLogger } from "../../logging/logger";
import type { serving, WorkspaceClient } from "../../workspace-client";
import { contextFromAbortSignal } from "../context";

const logger = createLogger("connectors:serving");

/**
 * Structural shape of the AppKit workspace client's raw-request seam
 * (`createWorkspaceClient().request`): sends through the modular transport
 * (AppKit User-Agent + auth) and returns the unread fetch `Response`.
 */
export interface WorkspaceRequestClientLike {
  request(req: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<Response>;
}

/**
 * Structural shape of a legacy Databricks SDK client's low-level
 * `apiClient.request` call.
 *
 * @deprecated Pass an AppKit workspace client ({@link WorkspaceRequestClientLike}).
 * Still accepted so callers passing a raw legacy SDK client keep working.
 */
export interface ApiClientLike {
  apiClient: {
    request(
      options: Record<string, unknown>,
      context?: unknown,
    ): Promise<unknown>;
  };
}

// The legacy SDK's `servingEndpoints.query` copied only these fields into the
// request body and dropped the rest; kept so invocations send the same payload.
const QUERY_FIELDS = [
  "client_request_id",
  "dataframe_records",
  "dataframe_split",
  "extra_params",
  "input",
  "inputs",
  "instances",
  "max_tokens",
  "messages",
  "n",
  "prompt",
  "stop",
  "stream",
  "temperature",
  "usage_context",
];

/** A client {@link streamPath} can send through. */
type StreamClientLike = WorkspaceRequestClientLike | ApiClientLike;

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
 * Invokes a serving endpoint. Returns the endpoint's JSON response as-is
 * (model-specific: chat, completions, embeddings, custom), plus the
 * `served-model-name` response header when present, like the legacy SDK's
 * `servingEndpoints.query`. Sent raw via `client.request` because the modular
 * serving SDK has no query method, and a generated unmarshal would strip
 * model-specific fields.
 */
export async function invoke(
  client: WorkspaceClient,
  endpointName: string,
  body: Record<string, unknown>,
): Promise<serving.QueryEndpointResponse> {
  // Strip `stream` from the body — the connector controls this
  const { stream: _stream, ...cleanBody } = body;

  logger.debug("Invoking endpoint %s", endpointName);

  const payload: Record<string, unknown> = {};
  for (const key of QUERY_FIELDS) {
    if (Object.hasOwn(cleanBody, key)) payload[key] = cleanBody[key];
  }

  const response = await client.request({
    method: "POST",
    path: `/serving-endpoints/${endpointName}/invocations`,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let json: serving.QueryEndpointResponse;
  try {
    json = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    // Same message (and typo) as the legacy SDK.
    throw new Error(`Can't parse reponse as JSON: ${text}`);
  }
  const servedModelName = response.headers.get("served-model-name");
  return servedModelName === null
    ? json
    : { ...json, "served-model-name": servedModelName };
}

/**
 * POSTs `body` as JSON to an arbitrary workspace API path and returns the raw
 * SSE byte stream. No parsing is performed — bytes are passed through as-is.
 *
 * Uses the workspace client's `request()` so callers inherit URL resolution,
 * the credential chain (PAT/OAuth/OIDC), and the AppKit User-Agent. A non-2xx
 * status throws `ApiError`. `signal` aborts the outbound HTTP request.
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
  client: StreamClientLike,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  logger.debug("Streaming from path %s", path);

  if ("request" in client) {
    const response = await client.request({
      method: "POST",
      path,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.body) {
      throw new Error("Response body is null — streaming not supported");
    }
    return response.body;
  }

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
  client: StreamClientLike,
  endpointName: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const { stream: _stream, ...cleanBody } = body;
  return streamPath(
    client,
    `/serving-endpoints/${encodeURIComponent(endpointName)}/invocations`,
    { ...cleanBody, stream: true },
    signal,
  );
}

/**
 * Returns the raw SSE byte stream from the Databricks AI Gateway Chat
 * Completions endpoint. Thin wrapper over {@link streamPath} that hard-codes
 * the gateway path and forces `stream: true`.
 *
 * Unlike a serving endpoint, the target model is named in the request body
 * (`body.model`, e.g. `"system.ai.claude-opus-5-5"`) — the gateway is a single
 * fixed path that routes by the body's `model`, so the caller sets it there.
 */
export async function streamAiGateway(
  client: StreamClientLike,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const { stream: _stream, ...cleanBody } = body;
  return streamPath(
    client,
    "/ai-gateway/mlflow/v1/chat/completions",
    { ...cleanBody, stream: true },
    signal,
  );
}
