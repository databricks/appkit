import type { VectorSearchPluginConfig, IndexConfig, SearchRequest, SearchResponse } from './types';
import { VectorSearchClient } from './VectorSearchClient';
import { ServicePrincipalTokenProvider, OboTokenExtractor } from './auth';

export class VectorSearchPlugin {
  static manifest = {
    name: 'vector-search',
    description: 'Query Databricks Vector Search indexes from your app',
    resources: { required: [] as any[], optional: [] as any[] },
    env: [
      { name: 'DATABRICKS_HOST', description: 'Databricks workspace hostname', source: 'auto' },
      { name: 'DATABRICKS_CLIENT_ID', description: 'Service principal client ID', source: 'auto' },
      { name: 'DATABRICKS_CLIENT_SECRET', description: 'Service principal client secret', source: 'auto' },
    ],
  };

  private config: VectorSearchPluginConfig;
  private client!: VectorSearchClient;
  private spTokenProvider!: ServicePrincipalTokenProvider;

  constructor(config: VectorSearchPluginConfig) {
    this.config = config;
  }

  async setup(): Promise<void> {
    const host = process.env.DATABRICKS_HOST;
    if (!host) {
      throw new Error(
        'DATABRICKS_HOST is not set. Ensure the app is deployed to Databricks Apps or set the environment variable manually.',
      );
    }

    // Fail-fast config validation
    for (const [alias, idx] of Object.entries(this.config.indexes)) {
      if (!idx.indexName) {
        throw new Error(`Index "${alias}" is missing required field "indexName"`);
      }
      if (!idx.columns || idx.columns.length === 0) {
        throw new Error(`Index "${alias}" is missing required field "columns"`);
      }
      if (idx.pagination && !idx.endpointName) {
        throw new Error(`Index "${alias}" has pagination enabled but is missing "endpointName"`);
      }
    }

    this.spTokenProvider = new ServicePrincipalTokenProvider(host);
    this.client = new VectorSearchClient({ host, tokenProvider: this.spTokenProvider });
  }

  async shutdown(): Promise<void> {
    // No cleanup needed currently
  }

  getResourceRequirements() {
    return Object.values(this.config.indexes).map((idx) => ({
      type: 'vector-search-index' as const,
      name: idx.indexName,
      permission: 'SELECT' as const,
    }));
  }

  exports() {
    return {
      query: (alias: string, request: SearchRequest) => this.executeQuery(alias, request),
    };
  }

  /** Resolve an index alias to its config. Throws if not found. */
  resolveIndex(alias: string): IndexConfig {
    const config = this.config.indexes[alias];
    if (!config) {
      throw {
        code: 'INDEX_NOT_FOUND' as const,
        message: `No index configured with alias "${alias}"`,
        statusCode: 404,
      };
    }
    return config;
  }

  /** Get the VS client instance (used by route handlers) */
  getClient(): VectorSearchClient {
    return this.client;
  }

  /** Get the full plugin config (used by route handlers) */
  getConfig(): VectorSearchPluginConfig {
    return this.config;
  }

  private async executeQuery(alias: string, request: SearchRequest): Promise<SearchResponse> {
    const indexConfig = this.resolveIndex(alias);
    return this.client.query({
      indexName: indexConfig.indexName,
      queryText: request.queryText,
      queryVector: request.queryVector,
      columns: request.columns ?? indexConfig.columns,
      numResults: request.numResults ?? indexConfig.numResults ?? 20,
      queryType: request.queryType ?? indexConfig.queryType ?? 'hybrid',
      filters: request.filters,
      reranker: request.reranker ?? indexConfig.reranker ?? false,
      embeddingFn: indexConfig.embeddingFn,
    });
  }
}
