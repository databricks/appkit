import { createLogger } from "../../logging/logger";
import type { TelemetryProvider } from "../../telemetry";
import {
  type Span,
  SpanKind,
  SpanStatusCode,
  TelemetryManager,
} from "../../telemetry";
import type { WorkspaceClient } from "../../workspace-client";
import type {
  AiSearchConnectorConfig,
  VsIndexInfo,
  VsNextPageParams,
  VsQueryParams,
  VsRawResponse,
} from "./types";

const logger = createLogger("connectors:ai-search");

/**
 * POST through the raw `request()` seam, not the typed `VectorSearchClient`:
 * its generated model has no `debug_level` (request) or `debug_info` (response),
 * so unmarshal would strip the timings the plugin reports, and its reranker
 * shape differs. Raw JSON keeps the exact wire shape `VsRawResponse` describes.
 */
async function postJson<T>(
  workspaceClient: WorkspaceClient,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await workspaceClient.request({
    method: "POST",
    path,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return (await res.json()) as T;
}

export class AiSearchConnector {
  private readonly telemetry: TelemetryProvider;

  constructor(config: AiSearchConnectorConfig = {}) {
    this.telemetry = TelemetryManager.getProvider(
      "ai-search",
      config.telemetry,
    );
  }

  async query(
    workspaceClient: WorkspaceClient,
    params: VsQueryParams,
    signal?: AbortSignal,
  ): Promise<VsRawResponse> {
    if (signal?.aborted) {
      throw new Error("Query cancelled before execution");
    }

    const body: Record<string, unknown> = {
      columns: params.columns,
      num_results: params.numResults,
      query_type: params.queryType.toUpperCase(),
      debug_level: 1,
    };

    if (params.queryText) body.query_text = params.queryText;
    if (params.queryVector) body.query_vector = params.queryVector;
    if (params.filters && Object.keys(params.filters).length > 0) {
      // VS silently ignores an object under `filters`; it wants a JSON string.
      body.filters_json = JSON.stringify(params.filters);
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

    return this.telemetry.startActiveSpan(
      "ai-search.query",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "databricks",
          "vs.index_name": params.indexName,
          "vs.query_type": params.queryType,
          "vs.num_results": params.numResults,
          "vs.has_filters": !!(
            params.filters && Object.keys(params.filters).length > 0
          ),
          "vs.has_reranker": !!params.reranker,
        },
      },
      async (span: Span) => {
        const startTime = Date.now();
        try {
          const response = await postJson<VsRawResponse>(
            workspaceClient,
            `/api/2.0/vector-search/indexes/${params.indexName}/query`,
            body,
            signal,
          );

          const duration = Date.now() - startTime;
          span.setAttribute("vs.result_count", response.result.row_count);
          span.setAttribute(
            "vs.query_time_ms",
            response.debug_info?.response_time ?? 0,
          );
          span.setAttribute("vs.duration_ms", duration);
          span.setStatus({ code: SpanStatusCode.OK });

          logger.event()?.setContext("ai-search", {
            index_name: params.indexName,
            query_type: params.queryType,
            result_count: response.result.row_count,
            query_time_ms: response.debug_info?.response_time ?? 0,
            duration_ms: duration,
          });

          return response;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      { name: "ai-search", includePrefix: true },
    );
  }

  async queryNextPage(
    workspaceClient: WorkspaceClient,
    params: VsNextPageParams,
    signal?: AbortSignal,
  ): Promise<VsRawResponse> {
    if (signal?.aborted) {
      throw new Error("Query cancelled before execution");
    }

    logger.debug(
      "Fetching next page for index %s (endpoint=%s)",
      params.indexName,
      params.endpointName,
    );

    return this.telemetry.startActiveSpan(
      "ai-search.queryNextPage",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "databricks",
          "vs.index_name": params.indexName,
          "vs.endpoint_name": params.endpointName,
        },
      },
      async (span: Span) => {
        try {
          const response = await postJson<VsRawResponse>(
            workspaceClient,
            `/api/2.0/vector-search/indexes/${params.indexName}/query-next-page`,
            {
              endpoint_name: params.endpointName,
              page_token: params.pageToken,
            },
            signal,
          );

          span.setAttribute("vs.result_count", response.result.row_count);
          span.setStatus({ code: SpanStatusCode.OK });
          return response;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      { name: "ai-search", includePrefix: true },
    );
  }

  /**
   * Fetches index metadata (index type, source table). Used to auto-discover
   * returnable columns when they aren't configured. No warehouse required.
   */
  async getIndex(
    workspaceClient: WorkspaceClient,
    indexName: string,
    signal?: AbortSignal,
  ): Promise<VsIndexInfo> {
    const index = await workspaceClient.vectorSearch.getVectorIndex(
      { name: indexName },
      { signal },
    );
    // Map the camelCase model back to the snake_case `VsIndexInfo` callers read.
    const spec =
      index.indexSpec?.$case === "deltaSyncIndexSpec"
        ? index.indexSpec.deltaSyncIndexSpec
        : undefined;
    return {
      index_type: index.indexType as VsIndexInfo["index_type"],
      delta_sync_index_spec: spec && {
        source_table: spec.sourceTable,
        embedding_vector_columns: spec.embeddingVectorColumns?.map((c) => ({
          name: c.name ?? "",
        })),
      },
    };
  }

  /**
   * Lists a Unity Catalog table's column names via the tables REST API
   * (no warehouse required).
   */
  async getSourceColumns(
    workspaceClient: WorkspaceClient,
    sourceTable: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const table = await workspaceClient.tables.getTable(
      { fullNameArg: sourceTable },
      { signal },
    );
    return (table.columns ?? []).flatMap((c) => (c.name ? [c.name] : []));
  }
}
