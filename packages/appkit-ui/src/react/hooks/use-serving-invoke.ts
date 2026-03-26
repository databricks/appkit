import { useCallback, useEffect, useRef, useState } from "react";

export interface UseServingInvokeOptions {
  /** Endpoint alias for named mode. Omit for default mode. */
  alias?: string;
  /** If false, does not invoke automatically on mount. Default: false */
  autoStart?: boolean;
}

export interface UseServingInvokeResult<T = unknown> {
  /** Trigger the invocation. */
  invoke: () => void;
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
 */
export function useServingInvoke<T = unknown>(
  body: Record<string, unknown>,
  options: UseServingInvokeOptions = {},
): UseServingInvokeResult<T> {
  const { alias, autoStart = false } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const urlSuffix = alias
    ? `/api/serving/${encodeURIComponent(alias)}/invoke`
    : "/api/serving/invoke";

  const invoke = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    setLoading(true);
    setError(null);
    setData(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    fetch(urlSuffix, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const errorBody = await res.json().catch(() => null);
          throw new Error(errorBody?.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((result: T) => {
        setData(result);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (abortController.signal.aborted) return;
        setError(err.message || "Request failed");
        setLoading(false);
      });
  }, [urlSuffix, body]);

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
