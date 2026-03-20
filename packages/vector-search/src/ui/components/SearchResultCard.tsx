import * as React from 'react';
import type { SearchResult } from '../../plugin/types';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface SearchResultCardProps<T extends Record<string, unknown>> {
  result: SearchResult<T>;
  titleColumn?: keyof T;
  descriptionColumn?: keyof T;
  displayColumns?: (keyof T)[];
  showScore?: boolean;
  query?: string;
}

export function SearchResultCard<T extends Record<string, unknown>>({
  result,
  titleColumn,
  descriptionColumn,
  displayColumns,
  showScore = false,
  query,
}: SearchResultCardProps<T>) {
  const title = titleColumn ? String(result.data[titleColumn] ?? '') : undefined;
  const description = descriptionColumn ? String(result.data[descriptionColumn] ?? '') : undefined;

  const highlight = (text: string): React.ReactNode => {
    if (!query) return text;
    const words = query.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return text;
    const regex = new RegExp(`(${words.map(escapeRegex).join('|')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part)
        ? <mark key={i} className="bg-yellow-100 text-inherit rounded-sm px-0.5">{part}</mark>
        : part
    );
  };

  return (
    <div className="rounded-lg border border-gray-200 p-4 hover:border-gray-300 hover:shadow-sm transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {title && (
            <h3 className="text-sm font-medium text-gray-900 truncate">
              {highlight(title)}
            </h3>
          )}
          {description && (
            <p className="mt-1 text-sm text-gray-600 line-clamp-2">
              {highlight(description)}
            </p>
          )}
          {displayColumns && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {displayColumns
                .filter(col => col !== titleColumn && col !== descriptionColumn)
                .map(col => (
                  <span key={String(col)} className="text-xs text-gray-500">
                    <span className="font-medium">{String(col)}:</span>{' '}
                    {String(result.data[col] ?? '—')}
                  </span>
                ))}
            </div>
          )}
        </div>
        {showScore && (
          <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
            {(result.score * 100).toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  );
}
