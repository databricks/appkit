import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClient, connectSSE } from "@/js";
import type {
  AnalyticsFormat,
  InferParams,
  InferResultByFormat,
  QueryKey,
  UseAnalyticsQueryOptions,
  UseAnalyticsQueryResult,
} from "./types";
import { useQueryHMR } from "./use-query-hmr";

function getDevMode() {
  const url = new URL(window.location.href);
  const searchParams = url.searchParams;
  const dev = searchParams.get("dev");

  return dev ? `?dev=${dev}` : "";
}

function getArrowStreamUrl(id: string) {
  return `/api/analytics/arrow-result/${id}`;
}

/**
 * Client-side defensive cap on inline Arrow IPC attachments (8 MiB decoded).
 * Mirrors the server's MAX_INLINE_ATTACHMENT_BYTES so a misconfigured proxy
 * (or a future server bug) can't push us into allocating an unbounded
 * Uint8Array and hanging the browser.
 *
 * REMOVE THIS GUARD if PR #320 (stash + serve via /arrow-result) lands —
 * that proposal eliminates the arrow_inline SSE path entirely, so bulk
 * bytes flow over HTTP where the browser handles backpressure natively
 * and Content-Length is exposed up-front.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Decode a base64 string into a Uint8Array suitable for Arrow IPC parsing. */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Subscribe to an analytics query over SSE and returns its latest result.
 * Integration hook between client and analytics plugin.
 *
 * The return type is automatically inferred based on the format:
 * - `format: "JSON_ARRAY"` (default): Returns typed array from QueryRegistry
 * - `format: "ARROW_STREAM"`: Returns TypedArrowTable with row type preserved
 *
 * Note: User context execution is determined by query file naming:
 * - `queryKey.obo.sql`: Executes as user (OBO = on-behalf-of / user delegation)
 * - `queryKey.sql`: Executes as service principal
 *
 * @param queryKey - Analytics query identifier
 * @param parameters - Query parameters (type-safe based on QueryRegistry)
 * @param options - Analytics query settings including format
 * @returns Query result state with format-appropriate data type
 *
 * @example JSON_ARRAY format (default)
 * ```typescript
 * const { data } = useAnalyticsQuery("spend_data", params);
 * // data: Array<{ group_key: string; cost_usd: number; ... }> | null
 * ```
 *
 * @example ARROW_STREAM format
 * ```typescript
 * const { data } = useAnalyticsQuery("spend_data", params, { format: "ARROW_STREAM" });
 * // data: TypedArrowTable<{ group_key: string; cost_usd: number; ... }> | null
 * ```
 */
export function useAnalyticsQuery<
  T = unknown,
  K extends QueryKey = QueryKey,
  F extends AnalyticsFormat = "JSON_ARRAY",
>(
  queryKey: K,
  parameters?: InferParams<K> | null,
  options: UseAnalyticsQueryOptions<F> = {} as UseAnalyticsQueryOptions<F>,
): UseAnalyticsQueryResult<InferResultByFormat<T, K, F>> {
  const format = options?.format ?? "JSON_ARRAY";
  const maxParametersSize = options?.maxParametersSize ?? 100 * 1024;
  const autoStart = options?.autoStart ?? true;

  const devMode = getDevMode();
  const urlSuffix = `/api/analytics/query/${encodeURIComponent(queryKey)}${devMode}`;

  type ResultType = InferResultByFormat<T, K, F>;
  const [data, setData] = useState<ResultType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  if (!queryKey || queryKey.trim().length === 0) {
    throw new Error(
      "useAnalyticsQuery: 'queryKey' must be a non-empty string.",
    );
  }

  const payload = useMemo(() => {
    try {
      const serialized = JSON.stringify({ parameters, format });
      const sizeInBytes = new Blob([serialized]).size;
      if (sizeInBytes > maxParametersSize) {
        throw new Error(
          "useAnalyticsQuery: Parameters size exceeds the maximum allowed size",
        );
      }

      return serialized;
    } catch (error) {
      console.error("useAnalyticsQuery: Failed to serialize parameters", error);
      return null;
    }
  }, [parameters, format, maxParametersSize]);

  const start = useCallback(() => {
    if (payload === null) {
      setError("Failed to serialize query parameters");
      return;
    }

    // Abort previous request if exists
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    setLoading(true);
    setError(null);
    setData(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    connectSSE({
      url: urlSuffix,
      payload: payload,
      signal: abortController.signal,
      onMessage: async (message) => {
        try {
          const parsed = JSON.parse(message.data);

          // success - JSON format
          if (parsed.type === "result") {
            setLoading(false);
            setData(parsed.data as ResultType);
            return;
          }

          // success - Arrow format (external links: fetch from server)
          if (parsed.type === "arrow") {
            try {
              const arrowData = await ArrowClient.fetchArrow(
                getArrowStreamUrl(parsed.statement_id),
              );
              const table = await ArrowClient.processArrowBuffer(arrowData);
              setLoading(false);
              // Table is cast to TypedArrowTable with row type from QueryRegistry
              setData(table as ResultType);
              return;
            } catch (error) {
              console.error(
                "[useAnalyticsQuery] Failed to fetch Arrow data",
                error,
              );
              setLoading(false);
              setError("Unable to load data, please try again");
              return;
            }
          }

          // success - Arrow format (inline: decode base64 IPC payload locally)
          if (parsed.type === "arrow_inline") {
            if (
              typeof parsed.attachment !== "string" ||
              parsed.attachment.length === 0
            ) {
              console.error(
                "[useAnalyticsQuery] arrow_inline message missing attachment",
              );
              setLoading(false);
              setError("Unable to load data, please try again");
              return;
            }
            // base64 length L decodes to ~L*3/4 bytes; reject before
            // allocating a multi-MiB Uint8Array.
            const decodedSize = Math.ceil((parsed.attachment.length * 3) / 4);
            if (decodedSize > MAX_INLINE_ATTACHMENT_BYTES) {
              console.error(
                "[useAnalyticsQuery] arrow_inline attachment exceeds %d bytes (got %d)",
                MAX_INLINE_ATTACHMENT_BYTES,
                decodedSize,
              );
              setLoading(false);
              setError("Unable to load data, please try again");
              return;
            }
            try {
              const buffer = decodeBase64(parsed.attachment);
              const table = await ArrowClient.processArrowBuffer(buffer);
              setLoading(false);
              setData(table as ResultType);
              return;
            } catch (error) {
              console.error(
                "[useAnalyticsQuery] Failed to decode inline Arrow data",
                error,
              );
              setLoading(false);
              setError("Unable to load data, please try again");
              return;
            }
          }

          // error
          if (parsed.type === "error" || parsed.error || parsed.code) {
            const errorMsg =
              parsed.error || parsed.message || "Unable to execute query";

            setLoading(false);
            setError(errorMsg);

            if (parsed.code) {
              console.error(
                `[useAnalyticsQuery] Code: ${parsed.code}, Message: ${errorMsg}`,
              );
            }
            return;
          }
        } catch (error) {
          console.warn("[useAnalyticsQuery] Malformed message received", error);
        }
      },
      onError: (error) => {
        if (abortController.signal.aborted) return;
        setLoading(false);

        let userMessage = "Unable to load data, please try again";

        if (error instanceof Error) {
          if (error.name === "AbortError") {
            userMessage = "Request timed out, please try again";
          } else if (error.message.includes("Failed to fetch")) {
            userMessage = "Network error. Please check your connection.";
          }

          console.error("[useAnalyticsQuery] Error", {
            queryKey,
            error: error.message,
            stack: error.stack,
          });
        }
        setError(userMessage);
      },
    });
  }, [queryKey, payload, urlSuffix]);

  useEffect(() => {
    if (autoStart) {
      start();
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [start, autoStart]);

  // Enable HMR for query updates in dev mode
  useQueryHMR(queryKey, start);

  return { data, loading, error };
}
