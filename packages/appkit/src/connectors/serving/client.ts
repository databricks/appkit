import type {
  CancellationToken,
  serving,
  WorkspaceClient,
} from "@databricks/sdk-experimental";
import { Context } from "@databricks/sdk-experimental";
import { createLogger } from "../../logging/logger";

const logger = createLogger("connectors:serving");

/**
 * Bridges {@link AbortSignal} to the SDK's {@link CancellationToken} so
 * `apiClient.request` can abort the outbound HTTP request (and stop pulling
 * the SSE body) when the agent run is cancelled.
 */
function cancellationTokenFromAbortSignal(
  signal: AbortSignal,
): CancellationToken {
  const listeners = new Set<() => void>();
  const fire = () => {
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        // ignore listener failures — abort must stay best-effort
      }
    }
  };
  signal.addEventListener("abort", fire, { passive: true });

  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(callback: (e?: unknown) => unknown) {
      listeners.add(callback as () => void);
      if (signal.aborted) {
        void callback();
      }
    },
  };
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
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const { stream: _stream, ...cleanBody } = body;

  logger.debug("Streaming from endpoint %s", endpointName);

  const context = signal
    ? new Context({
        cancellationToken: cancellationTokenFromAbortSignal(signal),
      })
    : undefined;

  const response = (await client.apiClient.request(
    {
      path: `/serving-endpoints/${encodeURIComponent(endpointName)}/invocations`,
      method: "POST",
      headers: new Headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      }),
      payload: { ...cleanBody, stream: true },
      raw: true,
    },
    context,
  )) as { contents: ReadableStream<Uint8Array> };

  if (!response.contents) {
    throw new Error("Response body is null — streaming not supported");
  }

  return response.contents;
}
