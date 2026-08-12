import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, test, vi } from "vitest";
import type { WorkspaceClient } from "../../../workspace-client";
import { AiSearchConnector } from "../client";
import type { VsRawResponse } from "../types";

async function captureSpans(
  operation: () => Promise<unknown>,
): Promise<{ spans: ReadableSpan[]; error?: unknown }> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const getTracerSpy = vi
    .spyOn(trace, "getTracer")
    .mockImplementation((name: string, version?: string) =>
      provider.getTracer(name, version),
    );
  let error: unknown;
  let spans: ReadableSpan[] = [];
  try {
    await operation();
  } catch (caught) {
    error = caught;
  } finally {
    await provider.forceFlush();
    spans = exporter.getFinishedSpans();
    getTracerSpy.mockRestore();
    await provider.shutdown();
  }
  return { spans, ...(error !== undefined ? { error } : {}) };
}

function workspaceClient(response: VsRawResponse | Error): WorkspaceClient {
  return {
    apiClient: {
      request:
        response instanceof Error
          ? vi.fn().mockRejectedValue(response)
          : vi.fn().mockResolvedValue(response),
    },
  } as unknown as WorkspaceClient;
}

function retrieverSpan(spans: ReadableSpan[]): ReadableSpan {
  const span = spans.find(
    (candidate) => candidate.attributes["mlflow.spanType"] === "RETRIEVER",
  );
  expect(span, "missing RETRIEVER span").toBeDefined();
  return span as ReadableSpan;
}

describe("AiSearchConnector semantic retrieval spans", () => {
  test("exports complete query inputs, documents, stable IDs, scores, and diagnostics", async () => {
    const response: VsRawResponse = {
      manifest: {
        column_count: 3,
        columns: [{ name: "id" }, { name: "text" }, { name: "score" }],
      },
      result: {
        row_count: 2,
        data_array: [
          ["doc-1", "Complete first row", 0.98],
          ["doc-2", "Complete second row", 0.87],
        ],
      },
      next_page_token: "page-2",
      debug_info: { response_time: 35 },
    };
    const connector = new AiSearchConnector();

    const observed = await captureSpans(() =>
      connector.query(workspaceClient(response), {
        columns: ["id", "text", "score"],
        filters: {
          category: ["observability"],
          password: "do-not-export",
        },
        indexName: "catalog.schema.docs",
        numResults: 2,
        queryText: "trace local agents",
        queryType: "hybrid",
        queryVector: [0.125, -0.5, 1.25],
        reranker: { columnsToRerank: ["text"] },
      }),
    );

    expect(observed.error).toBeUndefined();
    const span = retrieverSpan(observed.spans);
    expect(span.name).toBe("ai-search.query");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      "appkit.retriever.document_ids": ["doc-1", "doc-2"],
      "appkit.retriever.index_name": "catalog.schema.docs",
      "appkit.retriever.latency_ms": expect.any(Number),
      "appkit.retriever.query_type": "hybrid",
      "appkit.retriever.result_count": 2,
      "appkit.retriever.scores": [0.98, 0.87],
      "appkit.retriever.source": "databricks-ai-search",
      "db.system": "databricks",
      "vs.duration_ms": expect.any(Number),
      "vs.has_filters": true,
      "vs.has_reranker": true,
      "vs.index_name": "catalog.schema.docs",
      "vs.num_results": 2,
      "vs.query_time_ms": 35,
      "vs.query_type": "hybrid",
      "vs.result_count": 2,
    });
    expect(JSON.parse(String(span.attributes["mlflow.spanInputs"]))).toEqual({
      columns: ["id", "text", "score"],
      filters: {
        category: ["observability"],
        password: "[REDACTED]",
      },
      indexName: "catalog.schema.docs",
      numResults: 2,
      queryText: "trace local agents",
      queryType: "hybrid",
      queryVector: {
        dimensions: 3,
        sha256:
          "f6b2b238972f104fdfb47a54f079b06eda051734161400b60d305ad49d9b2d31",
      },
      reranker: { columnsToRerank: ["text"] },
    });
    expect(span.attributes["mlflow.spanInputs.original_bytes"]).toBe(348);
    expect(span.attributes["mlflow.spanInputs.sha256"]).toBe(
      "9bed2c6c6453eb7ee53685ae0669929c19fa5f538255c16fb7630d2faa5d4c1d",
    );
    expect(span.attributes["mlflow.spanInputs.truncated"]).toBe(false);
    expect(JSON.parse(String(span.attributes["mlflow.spanOutputs"]))).toEqual({
      documents: [
        {
          content: {
            id: "doc-1",
            score: 0.98,
            text: "Complete first row",
          },
          documentId: "doc-1",
          score: 0.98,
        },
        {
          content: {
            id: "doc-2",
            score: 0.87,
            text: "Complete second row",
          },
          documentId: "doc-2",
          score: 0.87,
        },
      ],
      nextPageToken: "page-2",
      resultCount: 2,
    });
    expect(span.attributes["mlflow.spanOutputs.original_bytes"]).toBe(261);
    expect(span.attributes["mlflow.spanOutputs.sha256"]).toBe(
      "5995c76a74fbcad7875c5d48a303a4d7d8d18317c155c502660938522344cebd",
    );
    expect(span.attributes["mlflow.spanOutputs.truncated"]).toBe(false);
    expect(span.attributes["mlflow.traceOutputs"]).toBeUndefined();
  });

  test("exports next-page documents and falls back to the captured-row digest", async () => {
    const response: VsRawResponse = {
      manifest: {
        column_count: 2,
        columns: [{ name: "title" }, { name: "score" }],
      },
      result: {
        row_count: 1,
        data_array: [["Fallback row", null]],
      },
      next_page_token: null,
    };
    const connector = new AiSearchConnector();

    const observed = await captureSpans(() =>
      connector.queryNextPage(workspaceClient(response), {
        endpointName: "endpoint-a",
        indexName: "catalog.schema.docs",
        pageToken: "page-2",
      }),
    );

    expect(observed.error).toBeUndefined();
    const span = retrieverSpan(observed.spans);
    expect(span.name).toBe("ai-search.queryNextPage");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      "appkit.retriever.document_ids": [
        "b48a75fb558784bfaaa5305827e9c364bc175160a556c56ff98f33a761980dcb",
      ],
      "appkit.retriever.index_name": "catalog.schema.docs",
      "appkit.retriever.latency_ms": expect.any(Number),
      "appkit.retriever.query_type": "next_page",
      "appkit.retriever.result_count": 1,
      "appkit.retriever.source": "databricks-ai-search",
      "vs.endpoint_name": "endpoint-a",
      "vs.index_name": "catalog.schema.docs",
      "vs.result_count": 1,
    });
    expect(JSON.parse(String(span.attributes["mlflow.spanInputs"]))).toEqual({
      endpointName: "endpoint-a",
      indexName: "catalog.schema.docs",
      pageToken: "page-2",
      queryType: "next_page",
    });
    expect(span.attributes["mlflow.spanInputs.original_bytes"]).toBe(108);
    expect(span.attributes["mlflow.spanInputs.sha256"]).toBe(
      "7d0315d01fd5b3d2f6179ff6604466f687cbf9146d3121f5511d7ad5be2e53d8",
    );
    expect(JSON.parse(String(span.attributes["mlflow.spanOutputs"]))).toEqual({
      documents: [
        {
          content: { score: null, title: "Fallback row" },
          documentId:
            "b48a75fb558784bfaaa5305827e9c364bc175160a556c56ff98f33a761980dcb",
          score: null,
        },
      ],
      nextPageToken: null,
      resultCount: 1,
    });
    expect(span.attributes["mlflow.spanOutputs.original_bytes"]).toBe(195);
    expect(span.attributes["mlflow.spanOutputs.sha256"]).toBe(
      "16dae38790838bdcc2dc5a62e1b27bbe9f804570cdb467bb111cc454d4c49ffd",
    );
  });

  test("ends a failed retriever with a sanitized exception event", async () => {
    const connector = new AiSearchConnector();
    const failure = new Error("vector backend exposed password hunter2");

    const observed = await captureSpans(() =>
      connector.query(workspaceClient(failure), {
        columns: ["id", "text"],
        indexName: "catalog.schema.docs",
        numResults: 2,
        queryText: "trace failures",
        queryType: "ann",
      }),
    );

    expect(observed.error).toBe(failure);
    const span = retrieverSpan(observed.spans);
    expect(span.attributes).toMatchObject({
      "appkit.retriever.latency_ms": expect.any(Number),
      "vs.duration_ms": expect.any(Number),
    });
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "Retriever operation failed",
    });
    expect(span.events).toEqual([
      expect.objectContaining({
        name: "exception",
        attributes: expect.objectContaining({
          "exception.message": "Retriever operation failed",
        }),
      }),
    ]);
    expect(JSON.parse(String(span.attributes["mlflow.spanOutputs"]))).toEqual({
      error: "[REDACTED]",
    });
    expect(JSON.parse(String(span.attributes["mlflow.spanInputs"]))).toEqual({
      columns: ["id", "text"],
      filters: {},
      indexName: "catalog.schema.docs",
      numResults: 2,
      queryText: "trace failures",
      queryType: "ann",
      queryVector: null,
      reranker: null,
    });
    expect(
      JSON.stringify({ attributes: span.attributes, events: span.events }),
    ).not.toContain("hunter2");
  });
});
