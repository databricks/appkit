import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VectorSearchPlugin } from '../../src/plugin/VectorSearchPlugin';

describe('VectorSearchPlugin', () => {
  beforeEach(() => {
    vi.stubEnv('DATABRICKS_HOST', 'test-host.databricks.com');
    vi.stubEnv('DATABRICKS_CLIENT_ID', 'test-client');
    vi.stubEnv('DATABRICKS_CLIENT_SECRET', 'test-secret');
  });

  describe('setup()', () => {
    it('throws if DATABRICKS_HOST is not set', async () => {
      vi.stubEnv('DATABRICKS_HOST', '');
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: { indexName: 'cat.sch.idx', columns: ['id'] },
        },
      });
      await expect(plugin.setup()).rejects.toThrow('DATABRICKS_HOST');
    });

    it('throws if any index is missing indexName', async () => {
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: { indexName: '', columns: ['id'] },
        },
      });
      await expect(plugin.setup()).rejects.toThrow('indexName');
    });

    it('throws if any index is missing columns', async () => {
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: { indexName: 'cat.sch.idx', columns: [] },
        },
      });
      await expect(plugin.setup()).rejects.toThrow('columns');
    });

    it('throws if pagination enabled but no endpointName', async () => {
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: { indexName: 'cat.sch.idx', columns: ['id'], pagination: true },
        },
      });
      await expect(plugin.setup()).rejects.toThrow('endpointName');
    });

    it('succeeds with valid config', async () => {
      const plugin = new VectorSearchPlugin({
        indexes: {
          products: {
            indexName: 'cat.sch.products_idx',
            columns: ['id', 'name', 'description'],
            queryType: 'hybrid',
            numResults: 20,
          },
          docs: {
            indexName: 'cat.sch.docs_idx',
            columns: ['id', 'title', 'content'],
            reranker: true,
            auth: 'on-behalf-of-user',
          },
        },
      });
      await expect(plugin.setup()).resolves.not.toThrow();
    });
  });

  describe('exports()', () => {
    it('returns object with query function', async () => {
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: { indexName: 'cat.sch.idx', columns: ['id'] },
        },
      });
      await plugin.setup();
      const exports = plugin.exports();
      expect(exports).toHaveProperty('query');
      expect(typeof exports.query).toBe('function');
    });
  });

  describe('getResourceRequirements()', () => {
    it('returns resource entry for each configured index', () => {
      const plugin = new VectorSearchPlugin({
        indexes: {
          products: { indexName: 'cat.sch.products', columns: ['id'] },
          docs: { indexName: 'cat.sch.docs', columns: ['id'] },
        },
      });
      const resources = plugin.getResourceRequirements();
      expect(resources).toHaveLength(2);
      expect(resources[0]).toEqual({
        type: 'vector-search-index',
        name: 'cat.sch.products',
        permission: 'SELECT',
      });
      expect(resources[1]).toEqual({
        type: 'vector-search-index',
        name: 'cat.sch.docs',
        permission: 'SELECT',
      });
    });
  });

  describe('manifest', () => {
    it('has correct name and env declarations', () => {
      expect(VectorSearchPlugin.manifest.name).toBe('vector-search');
      expect(VectorSearchPlugin.manifest.env).toContainEqual(
        expect.objectContaining({ name: 'DATABRICKS_HOST' })
      );
    });
  });
});
