import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginName, PluginRoutes, RouteResponse } from "./types";

export interface UseCustomPluginOptions {
  autoStart?: boolean;
}

export interface UseCustomPluginResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useCustomPlugin<
  P extends PluginName,
  R extends PluginRoutes<P>,
>(
  plugin: P,
  route: R,
  options?: UseCustomPluginOptions,
): UseCustomPluginResult<RouteResponse<P, R>> {
  const [data, setData] = useState<RouteResponse<P, R> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    abortControllerRef.current?.abort();

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/${plugin}/${route}`, {
        signal: abortController.signal,
      });
      if (!response.ok) {
        throw new Error(`Request failed ${response.statusText}`);
      }

      const result = await response.json();

      if (!abortController.signal.aborted) {
        setData(result as RouteResponse<P, R>);
        setLoading(false);
        setError(null);
      }
    } catch (error) {
      if (abortController.signal.aborted) return;

      setLoading(false);

      let userMessage = "Unable to load data, please try again";

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          userMessage = "Request timed out, please try again";
        } else if (error.message.includes("Failed to fetch")) {
          userMessage = "Network error. Please check your connection.";
        } else {
          userMessage = error.message;
        }
        console.error("[useCustomPlugin] Error", {
          plugin,
          route,
          error: error.message,
          stack: error.stack,
        });
      }

      setError(userMessage);
    }
  }, [plugin, route]);

  useEffect(() => {
    if (options?.autoStart) start();

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [start, options?.autoStart]);

  return { data, loading, error, refetch: start };
}
