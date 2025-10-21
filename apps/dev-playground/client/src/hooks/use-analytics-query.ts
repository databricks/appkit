import { useEffect, useState } from "react";

interface UseAnalyticsQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useAnalyticsQuery<T>(
  queryKey: string,
  parameters: Record<string, any>,
): UseAnalyticsQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const params = JSON.stringify(parameters);

  useEffect(() => {
    let isCancelled = false;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/analytics/query/${queryKey}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: params,
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No reader found");
        }

        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done || isCancelled) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const jsonData = line.slice(6);
              try {
                const parsed = JSON.parse(jsonData);
                if (parsed.type === "result") {
                  setData(parsed.data);
                }
              } catch {
                // Ignore JSON parsing errors
              }
            } else if (line.startsWith("event: error")) {
              const errorLine = lines[lines.indexOf(line) + 1];
              if (errorLine?.startsWith("data: ")) {
                const errorData = JSON.parse(errorLine.slice(6));
                setError(errorData.error || "Unknown error");
              }
            }
          }
        }
      } catch (error) {
        if (!isCancelled) {
          setError(error instanceof Error ? error.message : "Unknown error");
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    fetchData();

    return () => {
      isCancelled = true;
    };
  }, [queryKey, params]);

  return { data, loading, error };
}
