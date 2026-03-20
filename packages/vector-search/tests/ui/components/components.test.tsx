import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchBox } from '../../../src/ui/components/SearchBox';
import { SearchResultCard } from '../../../src/ui/components/SearchResultCard';
import { SearchResults } from '../../../src/ui/components/SearchResults';
import { SearchLoadMore } from '../../../src/ui/components/SearchLoadMore';

describe('SearchBox', () => {
  it('renders input with placeholder', () => {
    render(<SearchBox onSearch={() => {}} placeholder="Search products..." />);
    expect(screen.getByPlaceholderText('Search products...')).toBeInTheDocument();
  });

  it('calls onSearch on input change', () => {
    const onSearch = vi.fn();
    render(<SearchBox onSearch={onSearch} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'test' } });
    expect(onSearch).toHaveBeenCalledWith('test');
  });

  it('shows clear button when value present', () => {
    render(<SearchBox onSearch={() => {}} value="test" />);
    expect(screen.getByLabelText('Clear search')).toBeInTheDocument();
  });

  it('hides clear button when value empty', () => {
    render(<SearchBox onSearch={() => {}} value="" />);
    expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
  });

  it('calls onSearch with empty string on clear', () => {
    const onSearch = vi.fn();
    render(<SearchBox onSearch={onSearch} value="test" />);
    fireEvent.click(screen.getByLabelText('Clear search'));
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('clears on Escape key', () => {
    const onSearch = vi.fn();
    render(<SearchBox onSearch={onSearch} value="test" />);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('shows loading spinner when isLoading', () => {
    render(<SearchBox onSearch={() => {}} isLoading />);
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });
});

describe('SearchResultCard', () => {
  const result = {
    score: 0.95,
    data: { id: 1, title: 'Machine Learning Guide', description: 'A guide to ML algorithms', category: 'books' },
  };

  it('renders title and description', () => {
    render(<SearchResultCard result={result} titleColumn="title" descriptionColumn="description" />);
    expect(screen.getByText('Machine Learning Guide')).toBeInTheDocument();
    expect(screen.getByText('A guide to ML algorithms')).toBeInTheDocument();
  });

  it('highlights query words with mark tags', () => {
    const { container } = render(
      <SearchResultCard result={result} titleColumn="title" query="Machine" />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent).toBe('Machine');
  });

  it('shows score badge when showScore is true', () => {
    render(<SearchResultCard result={result} showScore />);
    expect(screen.getByText('95%')).toBeInTheDocument();
  });

  it('hides score badge by default', () => {
    render(<SearchResultCard result={result} />);
    expect(screen.queryByText('95%')).not.toBeInTheDocument();
  });

  it('renders display columns as metadata', () => {
    render(
      <SearchResultCard
        result={result}
        titleColumn="title"
        displayColumns={['category']}
      />
    );
    expect(screen.getByText('category:')).toBeInTheDocument();
    expect(screen.getByText('books')).toBeInTheDocument();
  });
});

describe('SearchResults', () => {
  const results = [
    { score: 0.95, data: { id: 1, title: 'Result 1' } },
    { score: 0.87, data: { id: 2, title: 'Result 2' } },
  ];

  it('shows loading skeleton when loading with no results', () => {
    render(<SearchResults results={[]} isLoading={true} error={null} query="test" totalCount={0} queryTimeMs={0} />);
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('shows empty message when no results', () => {
    render(<SearchResults results={[]} isLoading={false} error={null} query="test" totalCount={0} queryTimeMs={0} />);
    expect(screen.getByText('No results found.')).toBeInTheDocument();
  });

  it('shows custom empty message', () => {
    render(<SearchResults results={[]} isLoading={false} error={null} query="test" totalCount={0} queryTimeMs={0} emptyMessage="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('shows error banner', () => {
    const error = { code: 'INTERNAL' as const, message: 'Server error', statusCode: 500 };
    render(<SearchResults results={[]} isLoading={false} error={error} query="test" totalCount={0} queryTimeMs={0} />);
    expect(screen.getByText('Search failed')).toBeInTheDocument();
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });

  it('renders results with summary', () => {
    render(<SearchResults results={results} isLoading={false} error={null} query="test" totalCount={2} queryTimeMs={35} titleColumn="title" />);
    expect(screen.getByText('2 results in 35ms')).toBeInTheDocument();
    expect(screen.getByText('Result 1')).toBeInTheDocument();
    expect(screen.getByText('Result 2')).toBeInTheDocument();
  });

  it('returns null when no query', () => {
    const { container } = render(<SearchResults results={[]} isLoading={false} error={null} query="" totalCount={0} queryTimeMs={0} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('SearchLoadMore', () => {
  it('renders button when hasMore is true', () => {
    render(<SearchLoadMore hasMore={true} isLoading={false} onLoadMore={() => {}} />);
    expect(screen.getByText('Load more results')).toBeInTheDocument();
  });

  it('renders nothing when hasMore is false', () => {
    const { container } = render(<SearchLoadMore hasMore={false} isLoading={false} onLoadMore={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows Loading... when isLoading', () => {
    render(<SearchLoadMore hasMore={true} isLoading={true} onLoadMore={() => {}} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('calls onLoadMore on click', () => {
    const onLoadMore = vi.fn();
    render(<SearchLoadMore hasMore={true} isLoading={false} onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByText('Load more results'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
