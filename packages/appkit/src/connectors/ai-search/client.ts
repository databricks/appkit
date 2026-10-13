import { createLogger } from "../../logging/logger";
import type { TelemetryProvider } from "../../telemetry";
import {
  type Span,
  SpanKind,
  SpanStatusCode,
  TelemetryManager,
} from "../../telemetry";
import type {
  QueryVectorIndexRequest,
  QueryVectorIndexResponse,
  WorkspaceClient,
} from "../../workspace-client";
import type {
  AiSearchConnectorConfig,
  VsIndexInfo,
  VsNextPageParams,
  VsQueryParams,
  VsRawResponse,
} from "./types";

const logger = createLogger("connectors:ai-search");

/**
 * Map the typed (camelCase) response back to the snake_case wire shape the
 * plugin reads. `debugInfo` relies on the sdk-vectorsearch pnpm patch. Rows
 * may hold `bigint` (the SDK parses with json-bigint); coerce to `number` so
 * results stay JSON-serializable, matching legacy `JSON.parse` precision.
 */
function toRawResponse(res: QueryVectorIndexResponse): VsRawResponse {
  return {
    manifest: {
      column_count: res.manifest?.columnCount ?? 0,
      columns: (res.manifest?.columns ?? []).map((c) => ({
        name: c.name ?? "",
        type: c.typeText,
      })),
    },
    result: {
      row_count: res.result?.rowCount ?? 0,
      data_array: (res.result?.dataArray ?? []).map((row) =>
        row.map((v) => (typeof v === "bigint" ? Number(v) : v)),
      ),
    },
    next_page_token: res.nextPageToken,
    debug_info: res.debugInfo as VsRawResponse["debug_info"],
  };
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

    const hasFilters = !!(
      params.filters && Object.keys(params.filters).length > 0
    );
    const req: QueryVectorIndexRequest = {
      name: params.indexName,
      columns: params.columns,
      numResults: params.numResults,
      queryType: params.queryType.toUpperCase(),
      // Makes the response carry `debug_info` timings (queryTimeMs).
      debugLevel: 1,
      queryText: params.queryText || undefined,
      queryVector: params.queryVector,
      // VS silently ignores an object under `filters`; it wants a JSON string.
      filtersJson: hasFilters ? JSON.stringify(params.filters) : undefined,
      reranker: params.reranker && {
        model: "databricks_reranker",
        parameters: { columnsToRerank: params.reranker.columnsToRerank },
      },
    };

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
          "vs.has_filters": hasFilters,
          "vs.has_reranker": !!params.reranker,
        },
      },
      async (span: Span) => {
        const startTime = Date.now();
        try {
          const response = toRawResponse(
            await workspaceClient.vectorSearch.queryVectorIndex(req, {
              signal,
            }),
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
          const response = toRawResponse(
            await workspaceClient.vectorSearch.queryVectorIndexNextPage(
              {
                name: params.indexName,
                endpointName: params.endpointName,
                pageToken: params.pageToken,
              },
              { signal },
            ),
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
