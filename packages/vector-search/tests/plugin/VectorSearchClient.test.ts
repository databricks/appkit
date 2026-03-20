import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VectorSearchClient } from '../../src/plugin/VectorSearchClient';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockTokenProvider = { getToken: vi.fn().mockResolvedValue('sp-token-123') };

describe('VectorSearchClient', () => {
  let client: VectorSearchClient;

  beforeEach(() => {
    client = new VectorSearchClient({
      host: 'test-workspace.databricks.com',
      tokenProvider: mockTokenProvider,
    });
    mockFetch.mockReset();
    mockTokenProvider.getToken.mockClear();
  });

  const validResponse = {
    manifest: { column_count: 3, columns: [{ name: 'id' }, { name: 'title' }, { name: 'score' }] },
    result: { row_count: 2, data_array: [[1, 'ML Guide', 0.95], [2, 'AI Primer', 0.87]] },
    next_page_token: null,
    debug_info: { response_time: 35 },
  };

  describe('query()', () => {
    it('constructs correct REST API URL and request body for hybrid search', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'machine learning',
        columns: ['id', 'title'], numResults: 10, queryType: 'hybrid',
      });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test-workspace.databricks.com/api/2.0/vector-search/indexes/cat.sch.idx/query');
      const body = JSON.parse(opts.body);
      expect(body.query_text).toBe('machine learning');
      expect(body.query_type).toBe('HYBRID');
      expect(body.num_results).toBe(10);
      expect(body.columns).toEqual(['id', 'title']);
      expect(body.debug_level).toBe(1);
    });

    it('includes filters when provided', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id'],
        numResults: 5, queryType: 'ann', filters: { category: ['books'] },
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.filters).toEqual({ category: ['books'] });
    });

    it('omits filters when empty object', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id'],
        numResults: 5, queryType: 'ann', filters: {},
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.filters).toBeUndefined();
    });

    it('includes reranker config when boolean true', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id', 'title'],
        numResults: 5, queryType: 'hybrid', reranker: true,
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reranker.model).toBe('databricks_reranker');
      // Default: all non-id columns
      expect(body.reranker.parameters.columns_to_rerank).toEqual(['title']);
    });

    it('includes custom reranker columnsToRerank', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id', 'title', 'desc'],
        numResults: 5, queryType: 'hybrid', reranker: { columnsToRerank: ['desc'] },
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reranker.parameters.columns_to_rerank).toEqual(['desc']);
    });

    it('parses VS data_array response into typed SearchResult[]', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      const result = await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id', 'title'],
        numResults: 10, queryType: 'hybrid',
      });
      expect(result.results).toHaveLength(2);
      expect(result.results[0].score).toBe(0.95);
      expect(result.results[0].data).toEqual({ id: 1, title: 'ML Guide' });
      expect(result.results[1].score).toBe(0.87);
      expect(result.results[1].data).toEqual({ id: 2, title: 'AI Primer' });
      expect(result.totalCount).toBe(2);
      expect(result.queryTimeMs).toBe(35);
      expect(result.fromCache).toBe(false);
      expect(result.nextPageToken).toBeNull();
    });

    it('handles next_page_token in response', async () => {
      const responseWithToken = { ...validResponse, next_page_token: 'abc123' };
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(responseWithToken) });
      const result = await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id', 'title'],
        numResults: 10, queryType: 'hybrid',
      });
      expect(result.nextPageToken).toBe('abc123');
    });

    it('uses SP token when no userToken provided', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id'],
        numResults: 5, queryType: 'ann',
      });
      expect(mockTokenProvider.getToken).toHaveBeenCalled();
      expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer sp-token-123');
    });

    it('uses userToken when provided (OBO)', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id'],
        numResults: 5, queryType: 'ann', userToken: 'user-token-456',
      });
      expect(mockTokenProvider.getToken).not.toHaveBeenCalled();
      expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer user-token-456');
    });

    it('calls embeddingFn and sends query_vector for self-managed indexes', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      const mockEmbeddingFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id', 'title'],
        numResults: 5, queryType: 'ann', embeddingFn: mockEmbeddingFn,
      });
      expect(mockEmbeddingFn).toHaveBeenCalledWith('test');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query_vector).toEqual([0.1, 0.2, 0.3]);
      expect(body.query_text).toBeUndefined();
    });

    it('sends query_text when no embeddingFn (managed embeddings)', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id'],
        numResults: 5, queryType: 'ann',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query_text).toBe('test');
      expect(body.query_vector).toBeUndefined();
    });

    it('throws INVALID_QUERY when neither queryText nor queryVector provided', async () => {
      await expect(client.query({
        indexName: 'x', columns: ['id'], numResults: 1, queryType: 'ann',
      } as any)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    });

    it('maps 401 → UNAUTHORIZED', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401 });
      await expect(client.query({
        indexName: 'x', queryText: 't', columns: ['id'], numResults: 1, queryType: 'ann',
      })).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    });

    it('maps 404 → INDEX_NOT_FOUND', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      await expect(client.query({
        indexName: 'x', queryText: 't', columns: ['id'], numResults: 1, queryType: 'ann',
      })).rejects.toMatchObject({ code: 'INDEX_NOT_FOUND', statusCode: 404 });
    });

    it('maps 429 → RATE_LIMITED and retries', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(validResponse) });
      const result = await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id', 'title'],
        numResults: 5, queryType: 'ann',
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.results).toHaveLength(2);
    });

    it('does not retry 400 errors', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400 });
      await expect(client.query({
        indexName: 'x', queryText: 't', columns: ['id'], numResults: 1, queryType: 'ann',
      })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('retries 500 errors up to 3 times', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      await expect(client.query({
        indexName: 'x', queryText: 't', columns: ['id'], numResults: 1, queryType: 'ann',
      })).rejects.toMatchObject({ code: 'INTERNAL', statusCode: 500 });
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('retries network errors', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(validResponse) });
      const result = await client.query({
        indexName: 'cat.sch.idx', queryText: 'test', columns: ['id', 'title'],
        numResults: 5, queryType: 'ann',
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.results).toHaveLength(2);
    });
  });

  describe('queryNextPage()', () => {
    it('calls the query-next-page endpoint with page token', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(validResponse) });
      await client.queryNextPage({
        indexName: 'cat.sch.idx', endpointName: 'my-endpoint',
        pageToken: 'token123',
      });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test-workspace.databricks.com/api/2.0/vector-search/indexes/cat.sch.idx/query-next-page');
      const body = JSON.parse(opts.body);
      expect(body.endpoint_name).toBe('my-endpoint');
      expect(body.page_token).toBe('token123');
    });
  });
});
