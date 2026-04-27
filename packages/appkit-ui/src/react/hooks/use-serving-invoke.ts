import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InferServingRequest,
  InferServingResponse,
  ServingAlias,
  ServingClientConfig,
} from "./types";
import { usePluginClientConfig } from "./use-plugin-config";

export interface UseServingInvokeOptions<
  K extends ServingAlias = ServingAlias,
> {
  /** Endpoint alias for named mode. Omit for default mode. */
  alias?: K;
  /** If false, does not invoke automatically on mount. Default: false */
  autoStart?: boolean;
}

export interface UseServingInvokeResult<
  T = unknown,
  TBody = Record<string, unknown>,
> {
  /** Trigger the invocation. Pass an optional body override for this invocation. */
  invoke: (overrideBody?: TBody) => Promise<T | null>;
  /** Response data, null until loaded. */
  data: T | null;
  /** Whether a request is in progress. */
  loading: boolean;
  /** Error message, if any. */
  error: string | null;
}

/**
 * Hook for non-streaming invocation of a serving endpoint.
 * Calls `POST /api/serving/invoke` (default) or `POST /api/serving/{alias}/invoke` (named).
 *
 * When the type generator has populated `ServingEndpointRegistry`, the response type
 * is automatically inferred from the endpoint's OpenAPI schema.
 */
export function useServingInvoke<K extends ServingAlias = ServingAlias>(
  body: InferServingRequest<K>,
  options: UseServingInvokeOptions<K> = {} as UseServingInvokeOptions<K>,
): UseServingInvokeResult<InferServingResponse<K>, InferServingRequest<K>> {
  type TResponse = InferServingResponse<K>;
  const { alias, autoStart = false } = options;

  const config = usePluginClientConfig<ServingClientConfig>("serving");

  const aliasError = useMemo(() => {
    if (!alias || !config.aliases) return null;
    const aliasStr = String(alias);
    if (!config.aliases.includes(aliasStr)) {
      return `Unknown serving alias "${aliasStr}". Available: ${config.aliases.join(", ")}`;
    }
    return null;
  }, [alias, config.aliases]);

  const [data, setData] = useState<TResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(aliasError);
  const abortControllerRef = useRef<AbortController | null>(null);

  const urlSuffix = alias
    ? `/api/serving/${encodeURIComponent(String(alias))}/invoke`
    : "/api/serving/invoke";

  const bodyJson = JSON.stringify(body);

  const invoke = useCallback(
    (overrideBody?: InferServingRequest<K>): Promise<TResponse | null> => {
      if (aliasError) {
        setError(aliasError);
        return Promise.resolve(null);
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      setLoading(true);
      setError(null);
      setData(null);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const payload = overrideBody ? JSON.stringify(overrideBody) : bodyJson;

      return fetch(urlSuffix, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: abortController.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const errorBody = await res.json().catch(() => null);
            throw new Error(errorBody?.error || `HTTP ${res.status}`);
          }
          return res.json();
        })
        .then((result: TResponse) => {
          if (abortController.signal.aborted) return null;
          setData(result);
          setLoading(false);
          return result;
        })
        .catch((err: Error) => {
          if (abortController.signal.aborted) return null;
          setError(err.message || "Request failed");
          setLoading(false);
          return null;
        });
    },
    [urlSuffix, bodyJson, aliasError],
  );

  useEffect(() => {
    if (autoStart) {
      invoke();
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [invoke, autoStart]);

  return { invoke, data, loading, error };
}
