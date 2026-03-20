import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVectorSearch } from '../../../src/ui/hooks/useVectorSearch';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockResponse = {
  results: [{ score: 0.95, data: { id: 1, title: 'Test Result' } }],
  totalCount: 1,
  queryTimeMs: 20,
  queryType: 'hybrid',
  fromCache: false,
  nextPageToken: null,
};

/** Flush all pending microtasks (promise callbacks) */
const flushPromises = () => act(() => Promise.resolve());

describe('useVectorSearch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces search calls (300ms default)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) });
    const { result } = renderHook(() => useVectorSearch('products'));

    act(() => { result.current.search('a'); });
    act(() => { result.current.search('ab'); });
    act(() => { result.current.search('abc'); });

    // Before debounce fires
    expect(mockFetch).not.toHaveBeenCalled();

    // After debounce — advance timers then flush promises for fetch resolution
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.queryText).toBe('abc');
  });

  it('does not search below minQueryLength', async () => {
    const { result } = renderHook(() =>
      useVectorSearch('products', { minQueryLength: 3 })
    );

    act(() => { result.current.search('ab'); });
    await act(async () => { vi.advanceTimersByTime(400); });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it('sets isLoading true during search', async () => {
    let resolveJson!: (v: unknown) => void;
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: true,
        json: () => new Promise((r) => { resolveJson = r; }),
      })
    );

    const { result } = renderHook(() => useVectorSearch('products'));

    act(() => { result.current.search('test'); });
    await act(async () => { vi.advanceTimersByTime(300); });
    // fetch was called, but json() hasn't resolved yet
    await flushPromises();

    expect(result.current.isLoading).toBe(true);

    await act(async () => { resolveJson(mockResponse); });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.results).toHaveLength(1);
  });

  it('populates results after successful search', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) });
    const { result } = renderHook(() => useVectorSearch('products'));

    act(() => { result.current.search('test'); });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushPromises();

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].score).toBe(0.95);
    expect(result.current.results[0].data).toEqual({ id: 1, title: 'Test Result' });
    expect(result.current.totalCount).toBe(1);
    expect(result.current.queryTimeMs).toBe(20);
    expect(result.current.fromCache).toBe(false);
    expect(result.current.query).toBe('test');
  });

  it('sets error on failed search', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ code: 'INDEX_NOT_FOUND', message: 'Not found', statusCode: 404 }),
    });

    const { result } = renderHook(() => useVectorSearch('products'));

    act(() => { result.current.search('test'); });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushPromises();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.code).toBe('INDEX_NOT_FOUND');
    expect(result.current.isLoading).toBe(false);
  });

  it('clears everything on clear()', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) });
    const { result } = renderHook(() => useVectorSearch('products'));

    act(() => { result.current.search('test'); });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushPromises();

    expect(result.current.results).toHaveLength(1);

    act(() => { result.current.clear(); });

    expect(result.current.results).toEqual([]);
    expect(result.current.query).toBe('');
    expect(result.current.totalCount).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('re-executes search when filters change', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) });
    const { result } = renderHook(() => useVectorSearch('products'));

    act(() => { result.current.search('test'); });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.setFilters({ category: 'books' }); });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.filters).toEqual({ category: 'books' });
  });

  it('calls onResults callback on success', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) });
    const onResults = vi.fn();
    const { result } = renderHook(() =>
      useVectorSearch('products', { onResults })
    );

    act(() => { result.current.search('test'); });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushPromises();

    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenCalledWith(mockResponse);
  });

  it('calls onError callback on failure', async () => {
    const errorResponse = { code: 'INTERNAL', message: 'Server error', statusCode: 500 };
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve(errorResponse),
    });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useVectorSearch('products', { onError })
    );

    act(() => { result.current.search('test'); });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushPromises();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('sends request to correct API endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockResponse) });
    const { result } = renderHook(() => useVectorSearch('products'));

    act(() => { result.current.search('test'); });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls[0][0]).toBe('/api/vector-search/products/query');
  });
});
