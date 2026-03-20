import * as React from 'react';

interface SearchLoadMoreProps {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  className?: string;
}

export function SearchLoadMore({ hasMore, isLoading, onLoadMore, className }: SearchLoadMoreProps) {
  if (!hasMore) return null;

  return (
    <div className={`flex justify-center pt-4 ${className ?? ''}`}>
      <button
        onClick={onLoadMore}
        disabled={isLoading}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {isLoading ? 'Loading...' : 'Load more results'}
      </button>
    </div>
  );
}
