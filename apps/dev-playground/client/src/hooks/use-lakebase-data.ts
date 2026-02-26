import { useCallback, useEffect, useState } from "react";

interface UseLakebaseDataOptions {
  autoFetch?: boolean;
}

interface UseLakebaseDataResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Generic hook for fetching data from Lakebase example endpoints
 *
 * @example
 * const { data, loading, error, refetch } = useLakebaseData<Product[]>(
 *   '/api/lakebase-examples/raw/products'
 * );
 */
export function useLakebaseData<T = unknown>(
  endpoint: string,
  options: UseLakebaseDataOptions = {},
): UseLakebaseDataResult<T> {
  const { autoFetch = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(autoFetch);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const json = await response.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    if (autoFetch) {
      fetchData();
    }
  }, [autoFetch, fetchData]);

  return { data, loading, error, refetch: fetchData };
}

/**
 * Hook for posting data to Lakebase example endpoints
 */
export function useLakebasePost<TRequest = unknown, TResponse = unknown>(
  endpoint: string,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const post = useCallback(
    async (body: TRequest): Promise<TResponse | null> => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.message ||
              `HTTP ${response.status}: ${response.statusText}`,
          );
        }

        return await response.json();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [endpoint],
  );

  return { post, loading, error };
}

/**
 * Hook for PATCH requests to Lakebase example endpoints
 */
export function useLakebasePatch<TRequest = unknown, TResponse = unknown>(
  baseEndpoint: string,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const patch = useCallback(
    async (id: number | string, body: TRequest): Promise<TResponse | null> => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`${baseEndpoint}/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.message ||
              `HTTP ${response.status}: ${response.statusText}`,
          );
        }

        return await response.json();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [baseEndpoint],
  );

  return { patch, loading, error };
}
