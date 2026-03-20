import { describe, it, expect, beforeAll } from 'vitest';
import { VectorSearchClient } from '../../src/plugin/VectorSearchClient';

const DOGFOOD_HOST = 'e2-dogfood.staging.cloud.databricks.com';
const TEST_INDEX = 'gurary_catalog.vector-search-brickfood.retrieval_perf_cuj_index_1';

// Skip unless DOGFOOD_TOKEN is set
describe.skipIf(!process.env.DOGFOOD_TOKEN)('Integration: VectorSearchClient → dogfood', () => {
  let client: VectorSearchClient;

  beforeAll(() => {
    client = new VectorSearchClient({
      host: DOGFOOD_HOST,
      tokenProvider: {
        getToken: async () => process.env.DOGFOOD_TOKEN!,
      },
    });
  });

  it('returns results for a valid hybrid query', async () => {
    const response = await client.query({
      indexName: TEST_INDEX,
      queryText: 'aircraft instruments',
      columns: ['chunk_id', 'text'],
      numResults: 5,
      queryType: 'hybrid',
    });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0].score).toBeGreaterThan(0);
    expect(response.results[0].data).toHaveProperty('text');
    expect(response.results[0].data).toHaveProperty('chunk_id');
    expect(response.queryTimeMs).toBeGreaterThan(0);
  }, 30000);

  it('returns results for ANN query', async () => {
    const response = await client.query({
      indexName: TEST_INDEX,
      queryText: 'navigation systems',
      columns: ['chunk_id', 'text'],
      numResults: 3,
      queryType: 'ann',
    });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0].score).toBeGreaterThan(0);
  }, 30000);

  it('respects numResults limit', async () => {
    const response = await client.query({
      indexName: TEST_INDEX,
      queryText: 'flight',
      columns: ['chunk_id', 'text'],
      numResults: 2,
      queryType: 'hybrid',
    });
    expect(response.results.length).toBeLessThanOrEqual(2);
  }, 30000);

  it('returns scores between 0 and 1', async () => {
    const response = await client.query({
      indexName: TEST_INDEX,
      queryText: 'altitude',
      columns: ['chunk_id', 'text'],
      numResults: 5,
      queryType: 'hybrid',
    });
    response.results.forEach(r => {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    });
  }, 30000);

  it('handles empty results gracefully', async () => {
    const response = await client.query({
      indexName: TEST_INDEX,
      queryText: 'xyzzy_absolutely_no_match_12345_qwerty',
      columns: ['chunk_id', 'text'],
      numResults: 5,
      queryType: 'ann',
    });
    // May still return results due to embedding similarity, but should have low scores
    // If no results, that's fine too
    expect(response.results).toBeDefined();
    expect(Array.isArray(response.results)).toBe(true);
  }, 30000);

  it('response includes queryTimeMs from debug_info', async () => {
    const response = await client.query({
      indexName: TEST_INDEX,
      queryText: 'weather radar',
      columns: ['chunk_id', 'text'],
      numResults: 3,
      queryType: 'hybrid',
    });
    expect(response.queryTimeMs).toBeGreaterThan(0);
    expect(response.fromCache).toBe(false);
  }, 30000);
});
