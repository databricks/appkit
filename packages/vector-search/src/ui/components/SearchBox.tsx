import * as React from 'react';

interface SearchBoxProps {
  onSearch: (query: string) => void;
  value?: string;
  placeholder?: string;
  isLoading?: boolean;
  autoFocus?: boolean;
  className?: string;
}

export function SearchBox({
  onSearch,
  value,
  placeholder = 'Search...',
  isLoading = false,
  autoFocus = false,
  className,
}: SearchBoxProps) {
  const [internalValue, setInternalValue] = React.useState('');
  const displayValue = value ?? internalValue;
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (value === undefined) setInternalValue(val);
    onSearch(val);
  };

  const handleClear = () => {
    if (value === undefined) setInternalValue('');
    onSearch('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleClear();
  };

  return (
    <div className={`relative flex items-center rounded-lg border border-gray-300 bg-white shadow-sm focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 ${className ?? ''}`}>
      <svg className="ml-3 h-5 w-5 text-gray-400 shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full px-3 py-2.5 text-sm bg-transparent outline-none"
        role="searchbox"
        aria-label={placeholder}
      />
      {isLoading && (
        <div className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" data-testid="loading-spinner" />
      )}
      {displayValue && !isLoading && (
        <button
          onClick={handleClear}
          className="mr-3 rounded-sm p-0.5 text-gray-400 hover:text-gray-600"
          aria-label="Clear search"
        >
          <svg className="h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      )}
    </div>
  );
}
