import { useCallback, useEffect, useRef, useState } from "react";
import { connectSSE } from "@/js";
import type {
  InferServingChunk,
  InferServingRequest,
  ServingAlias,
} from "./types";

export interface UseServingStreamOptions<
  K extends ServingAlias = ServingAlias,
> {
  /** Endpoint alias for named mode. Omit for default mode. */
  alias?: K;
  /** If true, starts streaming automatically on mount. Default: false */
  autoStart?: boolean;
}

export interface UseServingStreamResult<T = unknown> {
  /** Trigger the streaming invocation. */
  stream: () => void;
  /** Accumulated chunks received so far. */
  chunks: T[];
  /** Whether streaming is in progress. */
  streaming: boolean;
  /** Error message, if any. */
  error: string | null;
  /** Reset chunks and abort any active stream. */
  reset: () => void;
}

/**
 * Hook for streaming invocation of a serving endpoint via SSE.
 * Calls `POST /api/serving/stream` (default) or `POST /api/serving/{alias}/stream` (named).
 * Accumulates parsed chunks in state.
 *
 * When the type generator has populated `ServingEndpointRegistry`, the chunk type
 * is automatically inferred from the endpoint's OpenAPI schema.
 */
export function useServingStream<K extends ServingAlias = ServingAlias>(
  body: InferServingRequest<K>,
  options: UseServingStreamOptions<K> = {} as UseServingStreamOptions<K>,
): UseServingStreamResult<InferServingChunk<K>> {
  type TChunk = InferServingChunk<K>;
  const { alias, autoStart = false } = options;

  const [chunks, setChunks] = useState<TChunk[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const urlSuffix = alias
    ? `/api/serving/${encodeURIComponent(alias as string)}/stream`
    : "/api/serving/stream";

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setChunks([]);
    setStreaming(false);
    setError(null);
  }, []);

  const bodyJson = JSON.stringify(body);

  const stream = useCallback(() => {
    // Abort any existing stream
    abortControllerRef.current?.abort();

    setStreaming(true);
    setError(null);
    setChunks([]);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    connectSSE({
      url: urlSuffix,
      payload: bodyJson,
      signal: abortController.signal,
      onMessage: async (message) => {
        if (abortController.signal.aborted) return;
        try {
          const parsed = JSON.parse(message.data);

          // Handle SSE error events from StreamManager
          if (parsed.error) {
            setError(parsed.error);
            setStreaming(false);
            return;
          }

          setChunks((prev) => [...prev, parsed as TChunk]);
        } catch {
          // Skip malformed messages
        }
      },
      onError: (err) => {
        if (abortController.signal.aborted) return;
        setStreaming(false);
        setError(err instanceof Error ? err.message : "Streaming failed");
      },
    }).then(() => {
      if (abortController.signal.aborted) return;
      // Stream completed
      setStreaming(false);
    });
  }, [urlSuffix, bodyJson]);

  useEffect(() => {
    if (autoStart) {
      stream();
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [stream, autoStart]);

  return { stream, chunks, streaming, error, reset };
}
