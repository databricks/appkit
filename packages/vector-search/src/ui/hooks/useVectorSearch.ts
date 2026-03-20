import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  SearchResult,
  SearchResponse,
  SearchError,
  SearchFilters,
  UseVectorSearchOptions,
  UseVectorSearchReturn,
} from '../../plugin/types';

export function useVectorSearch<T extends Record<string, unknown> = Record<string, unknown>>(
  alias: string,
  options: UseVectorSearchOptions = {},
): UseVectorSearchReturn<T> {
  const {
    debounceMs = 300,
    numResults,
    queryType,
    reranker,
    initialFilters = {},
    onResults,
    onError,
    minQueryLength = 1,
  } = options;

  const [results, setResults] = useState<SearchResult<T>[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<SearchError | null>(null);
  const [query, setQuery] = useState('');
  const [totalCount, setTotalCount] = useState(0);
  const [queryTimeMs, setQueryTimeMs] = useState(0);
  const [fromCache, setFromCache] = useState(false);
  const [activeFilters, setActiveFilters] = useState<SearchFilters>(initialFilters);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const nextPageTokenRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const executeSearch = useCallback(async (
    searchQuery: string,
    filters: SearchFilters,
    isLoadMore = false,
  ) => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    if (!isLoadMore) {
      setIsLoading(true);
      setError(null);
    } else {
      setIsLoadingMore(true);
    }

    try {
      const url = isLoadMore
        ? `/api/vector-search/${alias}/next-page`
        : `/api/vector-search/${alias}/query`;

      const body: Record<string, unknown> = isLoadMore
        ? { pageToken: nextPageTokenRef.current }
        : {
            queryText: searchQuery,
            ...(Object.keys(filters).length > 0 ? { filters } : {}),
            ...(numResults !== undefined ? { numResults } : {}),
            ...(queryType !== undefined ? { queryType } : {}),
            ...(reranker !== undefined ? { reranker } : {}),
          };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const err = await response.json();
        throw err as SearchError;
      }

      const data: SearchResponse<T> = await response.json();

      if (isLoadMore) {
        setResults(prev => [...prev, ...data.results]);
      } else {
        setResults(data.results);
      }

      setTotalCount(data.totalCount);
      setQueryTimeMs(data.queryTimeMs);
      setFromCache(data.fromCache);
      setHasMore(!!data.nextPageToken);
      nextPageTokenRef.current = data.nextPageToken;

      onResults?.(data as SearchResponse);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const searchError = err as SearchError;
      setError(searchError);
      onError?.(searchError);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [alias, numResults, queryType, reranker, onResults, onError]);

  const search = useCallback((searchQuery: string) => {
    setQuery(searchQuery);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (searchQuery.length < minQueryLength) {
      setResults([]);
      setTotalCount(0);
      setHasMore(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      executeSearch(searchQuery, activeFilters);
    }, debounceMs);
  }, [debounceMs, minQueryLength, activeFilters, executeSearch]);

  const setFilters = useCallback((filters: SearchFilters) => {
    setActiveFilters(filters);
    if (query.length >= minQueryLength) {
      executeSearch(query, filters);
    }
  }, [query, minQueryLength, executeSearch]);

  const loadMore = useCallback(() => {
    if (hasMore && !isLoadingMore && nextPageTokenRef.current) {
      executeSearch(query, activeFilters, true);
    }
  }, [hasMore, isLoadingMore, query, activeFilters, executeSearch]);

  const clear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    setQuery('');
    setResults([]);
    setError(null);
    setTotalCount(0);
    setQueryTimeMs(0);
    setFromCache(false);
    setHasMore(false);
    nextPageTokenRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return {
    search,
    results,
    isLoading,
    error,
    totalCount,
    queryTimeMs,
    fromCache,
    query,
    setFilters,
    activeFilters,
    clear,
    hasMore,
    loadMore,
    isLoadingMore,
  };
}
