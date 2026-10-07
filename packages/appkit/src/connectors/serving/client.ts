import { createLogger } from "../../logging/logger";
import type {
  serving,
  WorkspaceClient,
  WorkspaceRequest,
} from "../../workspace-client";
import { contextFromAbortSignal } from "../context";

const logger = createLogger("connectors:serving");

/**
 * Structural shape of a Databricks SDK client we need for the low-level
 * request call. Lets `streamPath` be reused by adapters that don't want a
 * hard dependency on the concrete `WorkspaceClient` type. AppKit's own client
 * provides `request` (modular transport); a caller-supplied legacy SDK client
 * only has `apiClient.request`, which stays supported.
 */
export interface ApiClientLike {
  apiClient: {
    request(
      options: Record<string, unknown>,
      context?: unknown,
    ): Promise<unknown>;
  };
  request?(req: WorkspaceRequest): Promise<Response>;
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
 * Uses the client's `request` (modular transport) when available, else the
 * legacy SDK's `apiClient.request({ raw: true })`, so callers inherit URL
 * resolution and the SDK credential chain (PAT/OAuth/OIDC).
 *
 * When `signal` is provided it aborts the outbound HTTP request.
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

  if (client.request) {
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
  client: ApiClientLike,
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
