import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkspaceClient } from "../../../workspace-client";
import { type MlflowUcConfig, MlflowUcSpanExporter } from "../../index";

const config: MlflowUcConfig = {
  experimentId: "experiment-123",
  catalogName: "main",
  schemaName: "agent_traces",
  tablePrefix: "appkit",
  otelSpansTableName: "main.agent_traces.appkit_otel_spans",
};

interface ObservedRequest {
  path: string;
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startBackend(
  handler?: (request: ObservedRequest, response: ServerResponse) => void,
) {
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const observed = {
      path: request.url ?? "",
      authorization: request.headers.authorization,
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(observed);
    if (handler) {
      handler(observed, response);
      return;
    }
    response.statusCode = 200;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return { host: `http://127.0.0.1:${port}`, requests };
}

function createClient(host: string, tokens: string[]): WorkspaceClient {
  let tokenIndex = 0;
  return {
    config: {
      host,
      ensureResolved: vi.fn().mockResolvedValue(undefined),
      authenticate: vi.fn(async (headers: Headers) => {
        headers.set("Authorization", `Bearer ${tokens[tokenIndex++]}`);
      }),
    },
  } as unknown as WorkspaceClient;
}

async function createTraceSpans(): Promise<ReadableSpan[]> {
  const inMemory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(inMemory)],
  });
  const tracer = provider.getTracer("mlflow-uc-exporter-test");
  const root = tracer.startSpan("support-agent", {
    startTime: 1_700_000_000_000,
    attributes: {
      "mlflow.spanType": "AGENT",
      "mlflow.spanInputs": '{"prompt":"hello"}',
      "mlflow.spanOutputs": '{"answer":"world"}',
      "mlflow.trace.session": "session-1",
      "mlflow.trace.user": "user-1",
      "mlflow.trace.tokenUsage":
        '{"input_tokens":4,"output_tokens":2,"total_tokens":6}',
      "appkit.app.name": "support-console",
      "appkit.request.id": "request-1",
      "appkit.thread.id": "thread-1",
      "appkit.agent.name": "support-agent",
      "appkit.route": "chat",
    },
  });
  root.setStatus({ code: SpanStatusCode.OK });
  root.end(1_700_000_000_250);
  await provider.forceFlush();
  const spans = inMemory.getFinishedSpans();
  await provider.shutdown();
  return spans;
}

function exportSpans(exporter: MlflowUcSpanExporter, spans: ReadableSpan[]) {
  return new Promise<{ code: ExportResultCode; error?: Error }>((resolve) =>
    exporter.export(spans, resolve),
  );
}

describe("MlflowUcSpanExporter", () => {
  test("authenticates each backend action and registers trace info before protobuf upload", async () => {
    const { host, requests } = await startBackend();
    const client = createClient(host, ["token-1", "token-2"]);
    const spans = await createTraceSpans();
    const otelTraceId = spans[0].spanContext().traceId;
    const exporter = new MlflowUcSpanExporter(config, client);

    await expect(exportSpans(exporter, spans)).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });

    expect(requests.map((request) => request.path)).toEqual([
      `/api/4.0/mlflow/traces/main.agent_traces.appkit/${otelTraceId}/info`,
      "/api/2.0/otel/v1/traces",
    ]);
    expect(requests.map((request) => request.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    expect(requests[1].headers["x-databricks-uc-table-name"]).toBe(
      "main.agent_traces.appkit_otel_spans",
    );

    const traceInfo = JSON.parse(requests[0].body.toString("utf8"));
    expect(traceInfo).toEqual({
      trace_id: `trace:/main.agent_traces.appkit/${otelTraceId}`,
      client_request_id: "request-1",
      trace_location: {
        type: "UC_TABLE_PREFIX",
        uc_table_prefix: {
          catalog_name: "main",
          schema_name: "agent_traces",
          table_prefix: "appkit",
          otel_spans_table_name: "main.agent_traces.appkit_otel_spans",
        },
      },
      request_preview: '{"prompt":"hello"}',
      response_preview: '{"answer":"world"}',
      request_time: "2023-11-14T22:13:20.000Z",
      execution_duration: "0.25s",
      state: "OK",
      trace_metadata: {
        "mlflow.trace_schema.version": "4",
        "mlflow.experimentId": "experiment-123",
        "mlflow.traceInputs": '{"prompt":"hello"}',
        "mlflow.traceOutputs": '{"answer":"world"}',
        "mlflow.trace.session": "session-1",
        "mlflow.trace.user": "user-1",
        "mlflow.trace.tokenUsage":
          '{"input_tokens":4,"output_tokens":2,"total_tokens":6}',
        "appkit.app.name": "support-console",
        "appkit.request.id": "request-1",
        "appkit.thread.id": "thread-1",
        "appkit.agent.name": "support-agent",
        "appkit.route": "chat",
      },
      tags: { "mlflow.traceName": "support-agent" },
      assessments: [],
    });
  });

  test("passes the exact UC header name to a freshly authenticated OTLP exporter", async () => {
    const { host, requests } = await startBackend();
    const client = createClient(host, ["token-1", "token-2"]);
    const spans = await createTraceSpans();
    const exportCalls: Array<{
      url: string;
      headers: Record<string, string>;
      spans: ReadableSpan[];
    }> = [];
    const exporter = new MlflowUcSpanExporter(config, client, {
      createOtlpExporter(options) {
        return {
          export(exportedSpans, callback) {
            exportCalls.push({ ...options, spans: exportedSpans });
            callback({ code: ExportResultCode.SUCCESS });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    await exportSpans(exporter, spans);

    expect(requests.map((request) => request.path)).toEqual([
      expect.stringMatching(/^\/api\/4\.0\/mlflow\/traces\//),
    ]);
    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0]).toMatchObject({
      url: `${host}/api/2.0/otel/v1/traces`,
      headers: {
        authorization: "Bearer token-2",
        "X-Databricks-UC-Table-Name": "main.agent_traces.appkit_otel_spans",
      },
      spans,
    });
  });

  test("isolates a backend rejection, calls back with success, and logs one structured error", async () => {
    const { host } = await startBackend((_request, response) => {
      response.statusCode = 500;
      response.end("backend unavailable");
    });
    const logger = { error: vi.fn() };
    const client = createClient(host, ["token-1"]);
    const spans = await createTraceSpans();
    const exporter = new MlflowUcSpanExporter(config, client, { logger });

    await expect(exportSpans(exporter, spans)).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "MLflow UC trace export failed: %O",
      expect.objectContaining({
        event: "mlflow_uc_trace_export_failed",
        traceId: expect.stringMatching(/^trace:\/main\.agent_traces\.appkit\//),
        error: "MLflow trace-info request failed with 500: backend unavailable",
      }),
    );
  });

  test("isolates an unresolved workspace host with an actionable export error", async () => {
    const logger = { error: vi.fn() };
    const client = createClient("", ["token-1"]);
    const spans = await createTraceSpans();
    const exporter = new MlflowUcSpanExporter(config, client, { logger });

    await expect(exportSpans(exporter, spans)).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(logger.error).toHaveBeenCalledWith(
      "MLflow UC trace export failed: %O",
      expect.objectContaining({
        error: "Databricks workspace host is unavailable for MLflow UC export",
      }),
    );
  });

  test("shutdown waits for in-flight trace-info and OTLP work", async () => {
    let releaseTraceInfo!: () => void;
    const traceInfoReleased = new Promise<void>((resolve) => {
      releaseTraceInfo = resolve;
    });
    let traceInfoStarted!: () => void;
    const traceInfoObserved = new Promise<void>((resolve) => {
      traceInfoStarted = resolve;
    });
    const { host } = await startBackend(async (_request, response) => {
      traceInfoStarted();
      await traceInfoReleased;
      response.statusCode = 200;
      response.end();
    });
    let finishOtlp!: () => void;
    const otlpFinished = new Promise<void>((resolve) => {
      finishOtlp = resolve;
    });
    let otlpStarted!: () => void;
    const otlpObserved = new Promise<void>((resolve) => {
      otlpStarted = resolve;
    });
    const client = createClient(host, ["token-1", "token-2"]);
    const spans = await createTraceSpans();
    const exporter = new MlflowUcSpanExporter(config, client, {
      createOtlpExporter() {
        return {
          export(_spans, callback) {
            otlpStarted();
            void otlpFinished.then(() =>
              callback({ code: ExportResultCode.SUCCESS }),
            );
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    exporter.export(spans, vi.fn());
    await traceInfoObserved;
    let shutdownComplete = false;
    const shutdown = exporter.shutdown().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    releaseTraceInfo();
    await otlpObserved;
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    finishOtlp();
    await shutdown;
    expect(shutdownComplete).toBe(true);
  });
});
