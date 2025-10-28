import { ArrowClient, connectSSE } from "@databricks-apps/js";
import { useEffect, useMemo, useRef, useState } from "react";

interface UseAnalyticsQueryResult<T> {
  data: T | null;
  arrowData: Uint8Array | null;
  loading: boolean;
  error: string | null;
}

function getArrowStreamUrl(id: string) {
  return `/api/analytics/arrow-result/${id}`;
}

export function useAnalyticsQuery<T>(
  queryKey: string,
  parameters: Record<string, any>,
  format: "ARROW" | "JSON" = "ARROW"
): UseAnalyticsQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [arrowData, setArrowData] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const params = useMemo(
    () => JSON.stringify({ parameters, format }),
    [parameters, format]
  );

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError(null);

      abortControllerRef.current = new AbortController();
      connectSSE({
        url: `/api/analytics/query/${queryKey}`,
        payload: params,
        signal: abortControllerRef.current?.signal,
        onMessage: async (message) => {
          try {
            const parsed = JSON.parse(message.data);

            if (parsed.type === "result") {
              setLoading(false);
              setData(parsed.data);
            }

            if (parsed.type === "arrow") {
              const arrowData = await ArrowClient.fetchArrow(
                getArrowStreamUrl(parsed.statement_id)
              );
              setLoading(false);
              setArrowData(arrowData);
            }
          } catch {
            // Ignore JSON parsing errors
          }
        },
      });
    }

    fetchData();

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [queryKey, params]);

  return { data, arrowData, loading, error };
}
