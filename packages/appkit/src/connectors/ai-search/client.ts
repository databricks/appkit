import { createLogger } from "../../logging/logger";
import type { TelemetryProvider } from "../../telemetry";
import {
  type Span,
  SpanKind,
  SpanStatusCode,
  TelemetryManager,
} from "../../telemetry";
import { captureTraceValue } from "../../telemetry/agent-tracing";
import type { WorkspaceClient } from "../../workspace-client";
import { contextFromAbortSignal } from "../context";
import type {
  AiSearchConnectorConfig,
  UcTableInfo,
  VsIndexInfo,
  VsNextPageParams,
  VsQueryParams,
  VsRawResponse,
} from "./types";

const logger = createLogger("connectors:ai-search");

const RETRIEVER_SOURCE = "databricks-ai-search";
const DOCUMENT_ID_COLUMNS = new Set(["id", "doc_id", "document_id"]);

interface RetrieverDocument {
  content: Record<string, unknown>;
  documentId: string;
  score: number | null;
}

interface RetrieverOutputs {
  documents: RetrieverDocument[];
  nextPageToken: string | null;
  resultCount: number;
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
          "mlflow.spanType": "RETRIEVER",
          "appkit.retriever.source": RETRIEVER_SOURCE,
          "appkit.retriever.index_name": params.indexName,
          "appkit.retriever.query_type": params.queryType,
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
        setCapturedAttribute(span, "mlflow.spanInputs", {
          columns: params.columns,
          filters: params.filters ?? {},
          indexName: params.indexName,
          numResults: params.numResults,
          queryText: params.queryText ?? null,
          queryType: params.queryType,
          queryVector: summarizeVector(params.queryVector),
          reranker: params.reranker ?? null,
        });
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
            contextFromAbortSignal(signal),
          )) as VsRawResponse;

          const duration = Date.now() - startTime;
          const outputs = retrieverOutputs(response, params.columns);
          setRetrieverOutputs(span, outputs);
          span.setAttribute("vs.result_count", response.result.row_count);
          span.setAttribute(
            "vs.query_time_ms",
            response.debug_info?.response_time ?? 0,
          );
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
          recordRetrieverFailure(span, error);
          throw error;
        } finally {
          const duration = Math.max(0, Date.now() - startTime);
          span.setAttribute("appkit.retriever.latency_ms", duration);
          span.setAttribute("vs.duration_ms", duration);
          span.end();
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
          "mlflow.spanType": "RETRIEVER",
          "appkit.retriever.source": RETRIEVER_SOURCE,
          "appkit.retriever.index_name": params.indexName,
          "appkit.retriever.query_type": "next_page",
          "db.system": "databricks",
          "vs.index_name": params.indexName,
          "vs.endpoint_name": params.endpointName,
        },
      },
      async (span: Span) => {
        const startTime = Date.now();
        setCapturedAttribute(span, "mlflow.spanInputs", {
          endpointName: params.endpointName,
          indexName: params.indexName,
          pageToken: params.pageToken,
          queryType: "next_page",
        });
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
            contextFromAbortSignal(signal),
          )) as VsRawResponse;

          const outputs = retrieverOutputs(response);
          setRetrieverOutputs(span, outputs);
          span.setAttribute("vs.result_count", response.result.row_count);
          span.setAttribute(
            "vs.query_time_ms",
            response.debug_info?.response_time ?? 0,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return response;
        } catch (error) {
          recordRetrieverFailure(span, error);
          throw error;
        } finally {
          const duration = Math.max(0, Date.now() - startTime);
          span.setAttribute("appkit.retriever.latency_ms", duration);
          span.setAttribute("vs.duration_ms", duration);
          span.end();
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
    return (await workspaceClient.apiClient.request(
      {
        method: "GET",
        path: `/api/2.0/vector-search/indexes/${indexName}`,
        headers: new Headers({ "Content-Type": "application/json" }),
        raw: false,
        query: {},
      },
      contextFromAbortSignal(signal),
    )) as VsIndexInfo;
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
    const table = (await workspaceClient.apiClient.request(
      {
        method: "GET",
        path: `/api/2.1/unity-catalog/tables/${sourceTable}`,
        headers: new Headers({ "Content-Type": "application/json" }),
        raw: false,
        query: {},
      },
      contextFromAbortSignal(signal),
    )) as UcTableInfo;
    return (table.columns ?? []).map((c) => c.name);
  }
}

function summarizeVector(
  vector: number[] | undefined,
): { dimensions: number; sha256: string } | null {
  if (!vector) return null;
  const captured = captureTraceValue(vector);
  return { dimensions: vector.length, sha256: captured.sha256 };
}

function retrieverOutputs(
  response: VsRawResponse,
  configuredColumns?: readonly string[],
): RetrieverOutputs {
  const columnNames = response.manifest.columns.map((column) => column.name);
  const configured = configuredColumns
    ? new Set(configuredColumns.map((column) => column.toLowerCase()))
    : undefined;
  const documentIdIndex = columnNames.findIndex((column) => {
    const normalized = column.toLowerCase();
    return (
      DOCUMENT_ID_COLUMNS.has(normalized) &&
      (configured === undefined || configured.has(normalized))
    );
  });
  const scoreIndex = columnNames.findIndex(
    (column) => column.toLowerCase() === "score",
  );
  const documents = response.result.data_array.map((row) => {
    const content = Object.fromEntries(
      columnNames.map((column, index) => [column, row[index] ?? null]),
    );
    const capturedRow = captureTraceValue(content);
    const returnedId = documentIdIndex >= 0 ? row[documentIdIndex] : undefined;
    const score = scoreIndex >= 0 ? row[scoreIndex] : undefined;
    return {
      content,
      documentId:
        returnedId === undefined || returnedId === null || returnedId === ""
          ? capturedRow.sha256
          : String(returnedId),
      score: typeof score === "number" ? score : null,
    };
  });
  return {
    documents,
    nextPageToken: response.next_page_token ?? null,
    resultCount: response.result.row_count,
  };
}

function setRetrieverOutputs(span: Span, outputs: RetrieverOutputs): void {
  setCapturedAttribute(span, "mlflow.spanOutputs", outputs);
  span.setAttribute("appkit.retriever.result_count", outputs.resultCount);
  span.setAttribute(
    "appkit.retriever.document_ids",
    outputs.documents.map((document) => document.documentId),
  );
  const scores = outputs.documents.flatMap((document) =>
    document.score === null ? [] : [document.score],
  );
  if (scores.length > 0) {
    span.setAttribute("appkit.retriever.scores", scores);
  }
}

function setCapturedAttribute(span: Span, key: string, value: unknown): void {
  const captured = captureTraceValue(value);
  span.setAttribute(key, captured.value);
  span.setAttribute(`${key}.original_bytes`, captured.originalBytes);
  span.setAttribute(`${key}.sha256`, captured.sha256);
  span.setAttribute(`${key}.truncated`, captured.truncated);
}

function recordRetrieverFailure(span: Span, error: unknown): void {
  const failure = captureTraceValue(
    {
      error:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
    },
    { redactKeys: ["error"] },
  );
  span.setAttribute("appkit.error", failure.value);
  span.setAttribute("mlflow.spanOutputs", failure.value);
  span.setAttribute("mlflow.spanOutputs.original_bytes", failure.originalBytes);
  span.setAttribute("mlflow.spanOutputs.sha256", failure.sha256);
  span.setAttribute("mlflow.spanOutputs.truncated", failure.truncated);
  span.recordException({
    name: "Error",
    message: "Retriever operation failed",
  });
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: "Retriever operation failed",
  });
}
