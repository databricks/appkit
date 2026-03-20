import type { SearchResponse, SearchFilters, SearchError, RerankerConfig, TokenProvider, VsRawResponse } from './types';

export class VectorSearchClient {
  private host: string;
  private tokenProvider: TokenProvider;

  constructor(config: { host: string; tokenProvider: TokenProvider }) {
    this.host = config.host;
    this.tokenProvider = config.tokenProvider;
  }

  async query(params: {
    indexName: string;
    queryText?: string;
    queryVector?: number[];
    columns: string[];
    numResults: number;
    queryType: 'ann' | 'hybrid' | 'full_text';
    filters?: SearchFilters;
    reranker?: boolean | RerankerConfig;
    userToken?: string;
    embeddingFn?: (text: string) => Promise<number[]>;
  }): Promise<SearchResponse> {
    const token = params.userToken ?? await this.tokenProvider.getToken();

    // Resolve query: managed (query_text) vs self-managed (query_vector)
    let queryText = params.queryText;
    let queryVector = params.queryVector;

    if (params.embeddingFn && queryText && !queryVector) {
      queryVector = await params.embeddingFn(queryText);
      queryText = undefined;
    }

    if (!queryText && !queryVector) {
      throw {
        code: 'INVALID_QUERY' as const,
        message: 'Either queryText or queryVector is required',
        statusCode: 400,
      };
    }

    const body: Record<string, unknown> = {
      columns: params.columns,
      num_results: params.numResults,
      query_type: params.queryType.toUpperCase(),
      debug_level: 1,
    };

    if (queryText) body.query_text = queryText;
    if (queryVector) body.query_vector = queryVector;

    if (params.filters && Object.keys(params.filters).length > 0) {
      body.filters = params.filters;
    }

    if (params.reranker) {
      const columnsToRerank = typeof params.reranker === 'object'
        ? params.reranker.columnsToRerank
        : params.columns.filter(c => c !== 'id');
      body.reranker = {
        model: 'databricks_reranker',
        parameters: { columns_to_rerank: columnsToRerank },
      };
    }

    const response = await this.fetchWithRetry(
      `https://${this.host}/api/2.0/vector-search/indexes/${params.indexName}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) throw this.mapError(response);
    const raw = await response.json() as VsRawResponse;
    return this.parseResponse(raw, params.queryType);
  }

  async queryNextPage(params: {
    indexName: string;
    endpointName: string;
    pageToken: string;
    userToken?: string;
  }): Promise<SearchResponse> {
    const token = params.userToken ?? await this.tokenProvider.getToken();

    const response = await this.fetchWithRetry(
      `https://${this.host}/api/2.0/vector-search/indexes/${params.indexName}/query-next-page`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint_name: params.endpointName,
          page_token: params.pageToken,
        }),
      },
    );

    if (!response.ok) throw this.mapError(response);
    const raw = await response.json() as VsRawResponse;
    return this.parseResponse(raw, 'hybrid');
  }

  private parseResponse(raw: VsRawResponse, queryType: 'ann' | 'hybrid' | 'full_text'): SearchResponse {
    const columnNames = raw.manifest.columns.map(c => c.name);
    const scoreIndex = columnNames.indexOf('score');

    const results = raw.result.data_array.map(row => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < columnNames.length; i++) {
        if (columnNames[i] !== 'score') data[columnNames[i]] = row[i];
      }
      return {
        score: scoreIndex >= 0 ? (row[scoreIndex] as number) : 0,
        data,
      };
    });

    return {
      results,
      totalCount: raw.result.row_count,
      queryTimeMs: raw.debug_info?.response_time ?? raw.debug_info?.latency_ms ?? 0,
      queryType,
      fromCache: false,
      nextPageToken: raw.next_page_token ?? null,
    };
  }

  private mapError(response: { status: number }): SearchError {
    const codeMap: Record<number, SearchError['code']> = {
      401: 'UNAUTHORIZED',
      403: 'UNAUTHORIZED',
      404: 'INDEX_NOT_FOUND',
      400: 'INVALID_QUERY',
      429: 'RATE_LIMITED',
    };
    return {
      code: codeMap[response.status] ?? 'INTERNAL',
      message: `VS query failed with status ${response.status}`,
      statusCode: response.status,
    };
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = 3,
    backoffMs = 1,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);

        // Don't retry client errors (4xx except 429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return response;
        }

        if (response.ok) {
          return response;
        }

        // Retry 429 and 5xx
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        return response;
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        throw {
          code: 'INTERNAL' as const,
          message: `Network error: ${lastError.message}`,
          statusCode: 500,
        };
      }
    }

    throw {
      code: 'INTERNAL' as const,
      message: 'Failed after retries',
      statusCode: 500,
    };
  }
}
