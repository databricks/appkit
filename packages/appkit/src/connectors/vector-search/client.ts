import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { createLogger } from "../../logging/logger";
import type {
  VectorSearchConnectorConfig,
  VsNextPageParams,
  VsQueryParams,
  VsRawResponse,
} from "./types";

const logger = createLogger("connectors:vector-search");

export class VectorSearchConnector {
  private readonly config: Required<VectorSearchConnectorConfig>;

  constructor(config: VectorSearchConnectorConfig = {}) {
    this.config = {
      timeout: config.timeout ?? 30_000,
    };
  }

  async query(
    workspaceClient: WorkspaceClient,
    params: VsQueryParams,
    signal?: AbortSignal,
  ): Promise<VsRawResponse> {
    const body: Record<string, unknown> = {
      columns: params.columns,
      num_results: params.numResults,
      query_type: params.queryType.toUpperCase(),
      debug_level: 1,
    };

    if (params.queryText) body.query_text = params.queryText;
    if (params.queryVector) body.query_vector = params.queryVector;
    if (params.filters && Object.keys(params.filters).length > 0) {
      body.filters = params.filters;
    }
    if (params.reranker) {
      body.reranker = {
        model: "databricks_reranker",
        parameters: { columns_to_rerank: params.reranker.columnsToRerank },
      };
    }

    logger.debug(
      "Querying VS index %s (type=%s, num_results=%d)",
      params.indexName,
      params.queryType,
      params.numResults,
    );

    return (await workspaceClient.apiClient.request({
      method: "POST",
      path: `/api/2.0/vector-search/indexes/${params.indexName}/query`,
      body,
      headers: new Headers({ "Content-Type": "application/json" }),
      raw: false,
      query: {},
    })) as VsRawResponse;
  }

  async queryNextPage(
    workspaceClient: WorkspaceClient,
    params: VsNextPageParams,
    signal?: AbortSignal,
  ): Promise<VsRawResponse> {
    logger.debug(
      "Fetching next page for index %s (endpoint=%s)",
      params.indexName,
      params.endpointName,
    );

    return (await workspaceClient.apiClient.request({
      method: "POST",
      path: `/api/2.0/vector-search/indexes/${params.indexName}/query-next-page`,
      body: {
        endpoint_name: params.endpointName,
        page_token: params.pageToken,
      },
      headers: new Headers({ "Content-Type": "application/json" }),
      raw: false,
      query: {},
    })) as VsRawResponse;
  }
}
