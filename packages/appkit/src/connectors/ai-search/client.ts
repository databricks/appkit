import type { CancellationToken } from "@databricks/sdk-experimental";
import { Context } from "@databricks/sdk-experimental";
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
  VsNextPageParams,
  VsQueryParams,
  VsRawResponse,
} from "./types";

const logger = createLogger("connectors:ai-search");

/**
 * Bridges {@link AbortSignal} to the SDK's {@link CancellationToken} so
 * `apiClient.request` aborts the outbound HTTP request when the execution's
 * timeout fires or the client disconnects. Mirrors the serving connector.
 */
function cancellationTokenFromAbortSignal(
  signal: AbortSignal,
): CancellationToken {
  const listeners = new Set<() => void>();
  signal.addEventListener(
    "abort",
    () => {
      for (const cb of listeners) {
        try {
          cb();
        } catch {
          // ignore listener failures — abort must stay best-effort
        }
      }
    },
    { passive: true },
  );

  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(callback: (e?: unknown) => unknown) {
      listeners.add(callback as () => void);
      if (signal.aborted) {
        void callback();
      }
    },
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
          const response = (await workspaceClient.apiClient.request(
            {
              method: "POST",
              path: `/api/2.0/vector-search/indexes/${params.indexName}/query`,
              payload: body,
              headers: new Headers({ "Content-Type": "application/json" }),
              raw: false,
              query: {},
            },
            signal
              ? new Context({
                  cancellationToken: cancellationTokenFromAbortSignal(signal),
                })
              : undefined,
          )) as VsRawResponse;

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
          const response = (await workspaceClient.apiClient.request(
            {
              method: "POST",
              path: `/api/2.0/vector-search/indexes/${params.indexName}/query-next-page`,
              payload: {
                endpoint_name: params.endpointName,
                page_token: params.pageToken,
              },
              headers: new Headers({ "Content-Type": "application/json" }),
              raw: false,
              query: {},
            },
            signal
              ? new Context({
                  cancellationToken: cancellationTokenFromAbortSignal(signal),
                })
              : undefined,
          )) as VsRawResponse;

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
}
