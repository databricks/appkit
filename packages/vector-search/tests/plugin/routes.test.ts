import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createVectorSearchRouter } from '../../src/plugin/routes';
import { VectorSearchPlugin } from '../../src/plugin/VectorSearchPlugin';

// Mock fetch for the VectorSearchClient
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Vector Search Routes', () => {
  let app: express.Express;
  let plugin: VectorSearchPlugin;

  const validVsResponse = {
    manifest: { column_count: 3, columns: [{ name: 'id' }, { name: 'title' }, { name: 'score' }] },
    result: { row_count: 2, data_array: [[1, 'ML Guide', 0.95], [2, 'AI Primer', 0.87]] },
    next_page_token: null,
    debug_info: { latency_ms: 35 },
  };

  beforeAll(async () => {
    vi.stubEnv('DATABRICKS_HOST', 'test-host.databricks.com');
    vi.stubEnv('DATABRICKS_CLIENT_ID', 'test-client');
    vi.stubEnv('DATABRICKS_CLIENT_SECRET', 'test-secret');

    plugin = new VectorSearchPlugin({
      indexes: {
        products: {
          indexName: 'cat.sch.products',
          columns: ['id', 'title', 'description', 'category'],
          queryType: 'hybrid',
          numResults: 20,
        },
        cached: {
          indexName: 'cat.sch.cached',
          columns: ['id', 'text'],
          cache: { enabled: true, ttlSeconds: 60 },
        },
        paginated: {
          indexName: 'cat.sch.paginated',
          columns: ['id', 'text'],
          pagination: true,
          endpointName: 'my-endpoint',
        },
        obo: {
          indexName: 'cat.sch.obo',
          columns: ['id', 'text'],
          auth: 'on-behalf-of-user',
        },
      },
    });
    await plugin.setup();

    app = express();
    app.use(express.json());
    app.use('/api/vector-search', createVectorSearchRouter(plugin));
  });

  beforeEach(() => {
    mockFetch.mockReset();
    // Mock the OIDC token fetch that happens on first query
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/oidc/v1/token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: 'sp-token', expires_in: 3600 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(validVsResponse),
      });
    });
  });

  describe('POST /:alias/query', () => {
    it('returns results for valid query', async () => {
      const res = await request(app)
        .post('/api/vector-search/products/query')
        .send({ queryText: 'machine learning' })
        .expect(200);

      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0].score).toBe(0.95);
      expect(res.body.results[0].data.title).toBe('ML Guide');
      expect(res.body.totalCount).toBe(2);
      expect(res.body.queryTimeMs).toBe(35);
    });

    it('returns 404 for unknown alias', async () => {
      const res = await request(app)
        .post('/api/vector-search/unknown/query')
        .send({ queryText: 'test' })
        .expect(404);

      expect(res.body.code).toBe('INDEX_NOT_FOUND');
    });

    it('returns 400 for missing queryText and queryVector', async () => {
      const res = await request(app)
        .post('/api/vector-search/products/query')
        .send({})
        .expect(400);

      expect(res.body.code).toBe('INVALID_QUERY');
    });

    it('passes filters to VS client', async () => {
      await request(app)
        .post('/api/vector-search/products/query')
        .send({ queryText: 'test', filters: { category: 'books' } })
        .expect(200);

      // Verify the VS API call included filters
      const vsCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/query')
      );
      expect(vsCall).toBeDefined();
      const body = JSON.parse(vsCall![1].body);
      expect(body.filters).toEqual({ category: 'books' });
    });

    it('uses OBO token when auth is on-behalf-of-user', async () => {
      await request(app)
        .post('/api/vector-search/obo/query')
        .set('x-forwarded-access-token', 'user-token-123')
        .send({ queryText: 'test' })
        .expect(200);

      const vsCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/query')
      );
      expect(vsCall![1].headers['Authorization']).toBe('Bearer user-token-123');
    });

    it('returns 401 when OBO index has no user token', async () => {
      const res = await request(app)
        .post('/api/vector-search/obo/query')
        .send({ queryText: 'test' })
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('POST /:alias/next-page', () => {
    it('returns 400 when pagination not enabled', async () => {
      const res = await request(app)
        .post('/api/vector-search/products/next-page')
        .send({ pageToken: 'abc' })
        .expect(400);

      expect(res.body.code).toBe('INVALID_QUERY');
      expect(res.body.message).toContain('Pagination');
    });

    it('returns 400 when pageToken missing', async () => {
      const res = await request(app)
        .post('/api/vector-search/paginated/next-page')
        .send({})
        .expect(400);

      expect(res.body.code).toBe('INVALID_QUERY');
      expect(res.body.message).toContain('pageToken');
    });

    it('calls query-next-page endpoint when valid', async () => {
      await request(app)
        .post('/api/vector-search/paginated/next-page')
        .send({ pageToken: 'token123' })
        .expect(200);

      const nextPageCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/query-next-page')
      );
      expect(nextPageCall).toBeDefined();
      const body = JSON.parse(nextPageCall![1].body);
      expect(body.page_token).toBe('token123');
      expect(body.endpoint_name).toBe('my-endpoint');
    });
  });

  describe('GET /:alias/config', () => {
    it('returns public config for valid alias', async () => {
      const res = await request(app)
        .get('/api/vector-search/products/config')
        .expect(200);

      expect(res.body.alias).toBe('products');
      expect(res.body.columns).toEqual(['id', 'title', 'description', 'category']);
      expect(res.body.queryType).toBe('hybrid');
      expect(res.body.numResults).toBe(20);
      expect(res.body.reranker).toBe(false);
      expect(res.body.pagination).toBe(false);
    });

    it('returns 404 for unknown alias', async () => {
      const res = await request(app)
        .get('/api/vector-search/unknown/config')
        .expect(404);

      expect(res.body.code).toBe('INDEX_NOT_FOUND');
    });
  });
});
