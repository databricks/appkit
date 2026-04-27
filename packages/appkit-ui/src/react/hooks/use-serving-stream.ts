import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectSSE } from "@/js";
import type {
  InferServingChunk,
  InferServingRequest,
  ServingAlias,
  ServingClientConfig,
} from "./types";
import { usePluginClientConfig } from "./use-plugin-config";

export interface UseServingStreamOptions<
  K extends ServingAlias = ServingAlias,
  T = InferServingChunk<K>,
> {
  /** Endpoint alias for named mode. Omit for default mode. */
  alias?: K;
  /** If true, starts streaming automatically on mount. Default: false */
  autoStart?: boolean;
  /** Called with accumulated chunks when the stream completes successfully. */
  onComplete?: (chunks: T[]) => void;
}

export interface UseServingStreamResult<
  T = unknown,
  TBody = Record<string, unknown>,
> {
  /** Trigger the streaming invocation. Pass an optional body override for this invocation. */
  stream: (overrideBody?: TBody) => void;
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
): UseServingStreamResult<InferServingChunk<K>, InferServingRequest<K>> {
  type TChunk = InferServingChunk<K>;
  const { alias, autoStart = false, onComplete } = options;

  const config = usePluginClientConfig<ServingClientConfig>("serving");

  const aliasError = useMemo(() => {
    if (!alias || !config.aliases) return null;
    const aliasStr = String(alias);
    if (!config.aliases.includes(aliasStr)) {
      return `Unknown serving alias "${aliasStr}". Available: ${config.aliases.join(", ")}`;
    }
    return null;
  }, [alias, config.aliases]);

  const [chunks, setChunks] = useState<TChunk[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(aliasError);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chunksRef = useRef<TChunk[]>([]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const urlSuffix = alias
    ? `/api/serving/${encodeURIComponent(String(alias))}/stream`
    : "/api/serving/stream";

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    chunksRef.current = [];
    setChunks([]);
    setStreaming(false);
    setError(null);
  }, []);

  const bodyJson = JSON.stringify(body);

  const stream = useCallback(
    (overrideBody?: InferServingRequest<K>) => {
      if (aliasError) {
        setError(aliasError);
        return;
      }

      // Abort any existing stream
      abortControllerRef.current?.abort();

      setStreaming(true);
      setError(null);
      setChunks([]);
      chunksRef.current = [];

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const payload = overrideBody ? JSON.stringify(overrideBody) : bodyJson;

      connectSSE({
        url: urlSuffix,
        payload,
        signal: abortController.signal,
        onMessage: async (message) => {
          if (abortController.signal.aborted) return;
          try {
            const parsed = JSON.parse(message.data);

            chunksRef.current = [...chunksRef.current, parsed as TChunk];
            setChunks(chunksRef.current);
          } catch {
            // Skip malformed messages
          }
        },
        onError: (err) => {
          if (abortController.signal.aborted) return;
          setStreaming(false);
          setError(err instanceof Error ? err.message : "Streaming failed");
        },
      })
        .then(() => {
          if (abortController.signal.aborted) return;
          // Stream completed
          setStreaming(false);
          onCompleteRef.current?.(chunksRef.current);
        })
        .catch(() => {
          if (abortController.signal.aborted) return;
          setStreaming(false);
          setError("Connection error");
        });
    },
    [urlSuffix, bodyJson, aliasError],
  );

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
