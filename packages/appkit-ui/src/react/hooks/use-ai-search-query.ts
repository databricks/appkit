import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AiSearchClientConfig,
  AiSearchIndexSummary,
  AiSearchRequest,
  AiSearchResponse,
} from "./types";
import { usePluginClientConfig } from "./use-plugin-config";

export interface UseAiSearchQueryOptions {
  /**
   * Index alias to query. Defaults to the first index exposed by the plugin's
   * `clientConfig()`, so a single-index app needs no alias.
   */
  alias?: string;
}

export interface UseAiSearchQueryResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Run a search. Pass query text, or a full request for filters/paging control. */
  search: (
    query: string | AiSearchRequest,
  ) => Promise<AiSearchResponse<T> | null>;
  /** Latest response, null until the first successful search. */
  data: AiSearchResponse<T> | null;
  /** Whether a search is in progress. */
  loading: boolean;
  /** Error message, if any. */
  error: string | null;
  /** The resolved alias this hook queries. */
  alias: string | null;
  /** All configured indexes, for building a selector. */
  indexes: AiSearchIndexSummary[];
}

/**
 * Hook for querying a Databricks AI Search index. Reads the available indexes
 * from the ai-search plugin's `clientConfig()` and POSTs to
 * `/api/ai-search/{alias}/query`, so the UI never hardcodes an endpoint alias.
 */
export function useAiSearchQuery<
  T extends Record<string, unknown> = Record<string, unknown>,
>(options: UseAiSearchQueryOptions = {}): UseAiSearchQueryResult<T> {
  const config = usePluginClientConfig<AiSearchClientConfig>("aiSearch");
  const indexes = config.indexes ?? [];

  const alias = options.alias ?? indexes[0]?.alias ?? null;

  // Config validation error; null for a valid alias.
  let aliasError: string | null = null;
  if (!alias) {
    aliasError = "No AI Search indexes are configured.";
  } else if (options.alias && !indexes.some((i) => i.alias === options.alias)) {
    const available = indexes.map((i) => i.alias).join(", ") || "none";
    aliasError = `Unknown AI Search index "${options.alias}". Available: ${available}`;
  }

  const [data, setData] = useState<AiSearchResponse<T> | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const error = fetchError ?? aliasError;
  const abortControllerRef = useRef<AbortController | null>(null);

  const search = useCallback(
    (query: string | AiSearchRequest): Promise<AiSearchResponse<T> | null> => {
      if (aliasError || !alias) {
        return Promise.resolve(null);
      }

      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      setLoading(true);
      setFetchError(null);
      setData(null);

      const body: AiSearchRequest =
        typeof query === "string" ? { queryText: query } : query;

      return fetch(`/api/ai-search/${encodeURIComponent(alias)}/query`, {
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
        .then((result: AiSearchResponse<T>) => {
          if (abortController.signal.aborted) return null;
          setData(result);
          setLoading(false);
          return result;
        })
        .catch((err: Error) => {
          if (abortController.signal.aborted) return null;
          setFetchError(err.message || "Search failed");
          setLoading(false);
          return null;
        });
    },
    [alias, aliasError],
  );

  // Reset when the target alias changes: abort any in-flight request (its
  // result would otherwise land under the new alias) and clear stale data +
  // fetch error. `error` re-derives from the new alias's validation state.
  useEffect(() => {
    abortControllerRef.current?.abort();
    setData(null);
    setLoading(false);
    setFetchError(null);
  }, [alias]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  return { search, data, loading, error, alias, indexes };
}
