import * as React from 'react';
import type { SearchResult, SearchError } from '../../plugin/types';
import { SearchResultCard } from './SearchResultCard';

interface SearchResultsProps<T extends Record<string, unknown>> {
  results: SearchResult<T>[];
  isLoading: boolean;
  error: SearchError | null;
  query: string;
  totalCount: number;
  queryTimeMs: number;
  renderResult?: (result: SearchResult<T>, index: number) => React.ReactNode;
  displayColumns?: (keyof T)[];
  titleColumn?: keyof T;
  descriptionColumn?: keyof T;
  showScores?: boolean;
  emptyMessage?: string;
  className?: string;
}

export function SearchResults<T extends Record<string, unknown>>({
  results,
  isLoading,
  error,
  query,
  totalCount,
  queryTimeMs,
  renderResult,
  displayColumns,
  titleColumn,
  descriptionColumn,
  showScores = false,
  emptyMessage = 'No results found.',
  className,
}: SearchResultsProps<T>) {
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <p className="font-medium">Search failed</p>
        <p className="mt-1 text-red-600">{error.message}</p>
      </div>
    );
  }

  if (isLoading && results.length === 0) {
    return (
      <div className="space-y-3" data-testid="loading-skeleton">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-lg border border-gray-200 p-4">
            <div className="h-4 w-2/3 rounded bg-gray-200" />
            <div className="mt-2 h-3 w-full rounded bg-gray-100" />
            <div className="mt-1 h-3 w-4/5 rounded bg-gray-100" />
          </div>
        ))}
      </div>
    );
  }

  if (!query) return null;

  if (results.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-500">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-3 text-xs text-gray-500">
        {totalCount} result{totalCount !== 1 ? 's' : ''} in {queryTimeMs}ms
      </div>
      <div className="space-y-2">
        {results.map((result, index) =>
          renderResult
            ? renderResult(result, index)
            : (
              <SearchResultCard
                key={index}
                result={result}
                titleColumn={titleColumn}
                descriptionColumn={descriptionColumn}
                displayColumns={displayColumns}
                showScore={showScores}
                query={query}
              />
            )
        )}
      </div>
    </div>
  );
}
