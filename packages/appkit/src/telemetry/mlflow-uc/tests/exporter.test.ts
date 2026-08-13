import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { context, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
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

async function createTraceSpans(
  options: { nestedAgent?: boolean } = {},
): Promise<ReadableSpan[]> {
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
      "mlflow.sourceRun": "run-99",
      "mlflow.trace.tokenUsage":
        '{"input_tokens":4,"output_tokens":2,"total_tokens":6}',
      "appkit.app.name": "support-console",
      "appkit.request.id": "request-1",
      "appkit.thread.id": "thread-1",
      "appkit.agent.name": "support-agent",
      "appkit.route": "chat",
    },
  });
  if (options.nestedAgent) {
    const nestedAgent = tracer.startSpan(
      "helper-agent",
      {
        startTime: 1_700_000_000_100,
        attributes: { "mlflow.spanType": "AGENT" },
      },
      trace.setSpan(context.active(), root),
    );
    const nestedTool = tracer.startSpan(
      "helper-tool",
      {
        startTime: 1_700_000_000_150,
        attributes: { "mlflow.spanType": "TOOL" },
      },
      trace.setSpan(context.active(), nestedAgent),
    );
    nestedTool.end(1_700_000_000_175);
    nestedAgent.end(1_700_000_000_200);
  }
  root.setStatus({ code: SpanStatusCode.OK });
  root.end(1_700_000_000_250);
  await provider.forceFlush();
  const spans = inMemory.getFinishedSpans();
  await provider.shutdown();
  return spans;
}

async function createRemoteParentTraceSpans(): Promise<ReadableSpan[]> {
  const inMemory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(inMemory)],
  });
  const tracer = provider.getTracer("mlflow-uc-remote-parent-test");
  const remoteParent = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  const agent = tracer.startSpan(
    "remote-child-agent",
    {
      startTime: 1_700_000_000_000,
      attributes: {
        "mlflow.spanType": "AGENT",
        "mlflow.spanInputs": '{"prompt":"remote"}',
        "mlflow.spanOutputs": '{"answer":"complete"}',
      },
    },
    trace.setSpanContext(context.active(), remoteParent),
  );
  agent.end(1_700_000_000_100);
  await provider.forceFlush();
  const spans = inMemory.getFinishedSpans();
  await provider.shutdown();
  return spans;
}

async function createHttpWrappedTraceSpans(): Promise<{
  http: ReadableSpan;
  agent: ReadableSpan;
  model: ReadableSpan;
}> {
  const inMemory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(inMemory)],
  });
  const tracer = provider.getTracer("mlflow-uc-http-root-test");
  const http = tracer.startSpan("POST /api/agents/chat", {
    startTime: 1_700_000_000_000,
  });
  const agent = tracer.startSpan(
    "support-agent",
    {
      startTime: 1_700_000_000_010,
      attributes: {
        "mlflow.spanType": "AGENT",
        "mlflow.spanInputs": '{"prompt":"hello"}',
        "mlflow.spanOutputs": '{"answer":"world"}',
      },
    },
    trace.setSpan(context.active(), http),
  );
  const model = tracer.startSpan(
    "model-step",
    {
      startTime: 1_700_000_000_020,
      attributes: { "mlflow.spanType": "CHAT_MODEL" },
    },
    trace.setSpan(context.active(), agent),
  );

  http.end(1_700_000_000_050);
  model.end(1_700_000_000_100);
  agent.end(1_700_000_000_150);
  await provider.forceFlush();
  const spans = inMemory.getFinishedSpans();
  await provider.shutdown();

  const readableHttp = spans.find(
    (span) => span.name === "POST /api/agents/chat",
  );
  const readableAgent = spans.find((span) => span.name === "support-agent");
  const readableModel = spans.find((span) => span.name === "model-step");
  if (!readableHttp || !readableAgent || !readableModel) {
    throw new Error("HTTP-wrapped trace fixture is incomplete");
  }
  return {
    http: readableHttp,
    agent: readableAgent,
    model: readableModel,
  };
}

function exportSpans(exporter: MlflowUcSpanExporter, spans: ReadableSpan[]) {
  return new Promise<{ code: ExportResultCode; error?: Error }>((resolve) =>
    exporter.export(spans, resolve),
  );
}

describe("MlflowUcSpanExporter", () => {
  test("splits mixed OTel trace batches and registers each semantic root before its isolated upload", async () => {
    const events: Array<
      | { kind: "trace-info"; traceId: string; rootName: string }
      | { kind: "otlp"; traceIds: string[] }
    > = [];
    const { host } = await startBackend((request, response) => {
      const traceId = request.path.match(/\/([0-9a-f]{32})\/info$/)?.[1];
      const traceInfo = JSON.parse(request.body.toString("utf8"));
      events.push({
        kind: "trace-info",
        traceId: traceId ?? "missing",
        rootName: traceInfo.tags["mlflow.traceName"],
      });
      response.statusCode = 200;
      response.end();
    });
    const client = createClient(host, [
      "token-1",
      "token-2",
      "token-3",
      "token-4",
    ]);
    const firstTrace = await createTraceSpans({ nestedAgent: true });
    const secondTrace = await createTraceSpans();
    const firstTraceId = firstTrace[0].spanContext().traceId;
    const secondTraceId = secondTrace[0].spanContext().traceId;
    const exporter = new MlflowUcSpanExporter(config, client, {
      createOtlpExporter() {
        return {
          export(spans, callback) {
            events.push({
              kind: "otlp",
              traceIds: [
                ...new Set(spans.map((span) => span.spanContext().traceId)),
              ],
            });
            callback({ code: ExportResultCode.SUCCESS });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    await expect(
      exportSpans(exporter, [...firstTrace, ...secondTrace]),
    ).resolves.toEqual({ code: ExportResultCode.SUCCESS });

    expect(events.filter((event) => event.kind === "trace-info")).toEqual([
      {
        kind: "trace-info",
        traceId: firstTraceId,
        rootName: "support-agent",
      },
      {
        kind: "trace-info",
        traceId: secondTraceId,
        rootName: "support-agent",
      },
    ]);
    expect(events.filter((event) => event.kind === "otlp")).toEqual([
      { kind: "otlp", traceIds: [firstTraceId] },
      { kind: "otlp", traceIds: [secondTraceId] },
    ]);
    for (const traceId of [firstTraceId, secondTraceId]) {
      const traceInfoIndex = events.findIndex(
        (event) => event.kind === "trace-info" && event.traceId === traceId,
      );
      const uploadIndex = events.findIndex(
        (event) => event.kind === "otlp" && event.traceIds.includes(traceId),
      );
      expect(traceInfoIndex).toBeGreaterThanOrEqual(0);
      expect(uploadIndex).toBeGreaterThan(traceInfoIndex);
    }
  });

  test("buffers split trace fragments until the top semantic AGENT arrives", async () => {
    const traceInfoRoots: Array<{ traceId: string; rootName: string }> = [];
    const uploads: Array<{ traceId: string; spanNames: string[] }> = [];
    const { host } = await startBackend((request, response) => {
      const traceId = request.path.match(/\/([0-9a-f]{32})\/info$/)?.[1];
      const traceInfo = JSON.parse(request.body.toString("utf8"));
      traceInfoRoots.push({
        traceId: traceId ?? "missing",
        rootName: traceInfo.tags["mlflow.traceName"],
      });
      response.statusCode = 200;
      response.end();
    });
    const client = createClient(host, [
      "token-1",
      "token-2",
      "token-3",
      "token-4",
    ]);
    const completeTrace = await createTraceSpans({ nestedAgent: true });
    const semanticRoot = completeTrace.find(
      (span) => span.name === "support-agent",
    );
    const earlierFragments = completeTrace.filter(
      (span) => span.name !== "support-agent",
    );
    if (!semanticRoot) throw new Error("semantic root fixture is missing");
    const traceId = semanticRoot.spanContext().traceId;
    const exporter = new MlflowUcSpanExporter(config, client, {
      createOtlpExporter() {
        return {
          export(spans, callback) {
            uploads.push({
              traceId: spans[0].spanContext().traceId,
              spanNames: spans.map((span) => span.name),
            });
            callback({ code: ExportResultCode.SUCCESS });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    await expect(exportSpans(exporter, earlierFragments)).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(traceInfoRoots).toEqual([]);
    expect(uploads).toEqual([]);
    await expect(exportSpans(exporter, [semanticRoot])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });

    expect(traceInfoRoots).toEqual([{ traceId, rootName: "support-agent" }]);
    expect(uploads).toEqual([
      {
        traceId,
        spanNames: ["helper-tool", "helper-agent", "support-agent"],
      },
    ]);
  });

  test("evicts the oldest incomplete trace when the pending trace limit is reached", async () => {
    const first = await createHttpWrappedTraceSpans();
    const second = await createHttpWrappedTraceSpans();
    const third = await createHttpWrappedTraceSpans();
    const uploadedTraceIds: string[] = [];
    const logger = { error: vi.fn() };
    const { host } = await startBackend();
    const client = createClient(host, ["token-1", "token-2"]);
    const exporter = new MlflowUcSpanExporter(config, client, {
      maxPendingTraces: 2,
      logger,
      createOtlpExporter() {
        return {
          export(spans, callback) {
            uploadedTraceIds.push(spans[0].spanContext().traceId);
            callback({ code: ExportResultCode.SUCCESS });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    await exportSpans(exporter, [first.http, second.http, third.http]);
    await exportSpans(exporter, [first.agent, first.model]);
    await exportSpans(exporter, [third.agent, third.model]);

    expect(uploadedTraceIds).toEqual([third.agent.spanContext().traceId]);
    expect(logger.error).toHaveBeenCalledWith(
      "Dropped incomplete MLflow UC trace: %O",
      expect.objectContaining({
        event: "mlflow_uc_incomplete_trace_dropped",
        traceId: first.http.spanContext().traceId,
        reason: "capacity",
      }),
    );
  });

  test("expires incomplete trace fragments before accepting later spans", async () => {
    let now = 1_000;
    const first = await createHttpWrappedTraceSpans();
    const second = await createHttpWrappedTraceSpans();
    const uploadedTraceIds: string[] = [];
    const logger = { error: vi.fn() };
    const { host } = await startBackend();
    const client = createClient(host, ["token-1", "token-2"]);
    const exporter = new MlflowUcSpanExporter(config, client, {
      pendingTraceTtlMs: 50,
      now: () => now,
      logger,
      createOtlpExporter() {
        return {
          export(spans, callback) {
            uploadedTraceIds.push(spans[0].spanContext().traceId);
            callback({ code: ExportResultCode.SUCCESS });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    await exportSpans(exporter, [first.http]);
    now += 51;
    await exportSpans(exporter, [first.agent, first.model]);
    await exportSpans(exporter, [second.http, second.agent, second.model]);

    expect(uploadedTraceIds).toEqual([second.agent.spanContext().traceId]);
    expect(logger.error).toHaveBeenCalledWith(
      "Dropped incomplete MLflow UC trace: %O",
      expect.objectContaining({
        event: "mlflow_uc_incomplete_trace_dropped",
        traceId: first.http.spanContext().traceId,
        reason: "ttl",
      }),
    );
  });

  test("caps retained fragments without dropping a semantic root that completes the trace", async () => {
    const spans = await createTraceSpans({ nestedAgent: true });
    const root = spans.find((span) => span.name === "support-agent");
    const fragments = spans.filter((span) => span !== root);
    if (!root) throw new Error("semantic root fixture is missing");
    const uploads: string[][] = [];
    const { host } = await startBackend();
    const client = createClient(host, ["token-1", "token-2"]);
    const exporter = new MlflowUcSpanExporter(config, client, {
      maxSpansPerTrace: 2,
      createOtlpExporter() {
        return {
          export(spans, callback) {
            uploads.push(spans.map((span) => span.name));
            callback({ code: ExportResultCode.SUCCESS });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    await exportSpans(exporter, fragments);
    await exportSpans(exporter, [root]);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toHaveLength(2);
    expect(uploads[0]).toContain("support-agent");
  });

  test("accepts a semantic AGENT whose missing parent context is remote", async () => {
    const spans = await createRemoteParentTraceSpans();
    const agent = spans[0];
    expect(agent.parentSpanContext?.isRemote).toBe(true);
    const { host, requests } = await startBackend();
    const client = createClient(host, ["token-1", "token-2"]);
    const exporter = new MlflowUcSpanExporter(config, client);

    await expect(exportSpans(exporter, spans)).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });

    expect(requests.map((request) => request.path)).toEqual([
      "/api/4.0/mlflow/traces/main.agent_traces.appkit/11111111111111111111111111111111/info",
      "/api/2.0/otel/v1/traces",
    ]);
  });

  test("retains an earlier local HTTP root and uploads only its later semantic AGENT subtree", async () => {
    const { http, agent, model } = await createHttpWrappedTraceSpans();
    expect(agent.parentSpanContext?.spanId).toBe(http.spanContext().spanId);
    expect(agent.parentSpanContext?.isRemote).not.toBe(true);
    expect(model.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    const traceInfoRoots: string[] = [];
    const uploads: string[][] = [];
    const { host } = await startBackend((request, response) => {
      const traceInfo = JSON.parse(request.body.toString("utf8"));
      traceInfoRoots.push(traceInfo.tags["mlflow.traceName"]);
      response.statusCode = 200;
      response.end();
    });
    const client = createClient(host, ["token-1", "token-2"]);
    const exporter = new MlflowUcSpanExporter(config, client, {
      createOtlpExporter() {
        return {
          export(spans, callback) {
            uploads.push(spans.map((span) => span.name));
            callback({ code: ExportResultCode.SUCCESS });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    await expect(exportSpans(exporter, [http])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(traceInfoRoots).toEqual([]);
    expect(uploads).toEqual([]);
    await expect(exportSpans(exporter, [model, agent])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });

    expect(traceInfoRoots).toEqual(["support-agent"]);
    expect(uploads).toEqual([["model-step", "support-agent"]]);
  });

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
      trace_id: otelTraceId,
      client_request_id: "request-1",
      trace_location: {
        type: "UC_TABLE_PREFIX",
        uc_table_prefix: {
          catalog_name: "main",
          schema_name: "agent_traces",
          table_prefix: "appkit",
          spans_table_name: "main.agent_traces.appkit_otel_spans",
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
        "mlflow.sourceRun": "run-99",
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
      headers: Record<string, string> | (() => Promise<Record<string, string>>);
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
      spans,
    });
    const headers = exportCalls[0].headers;
    await expect(
      typeof headers === "function" ? headers() : headers,
    ).resolves.toEqual({
      authorization: "Bearer token-2",
      "X-Databricks-UC-Table-Name": "main.agent_traces.appkit_otel_spans",
    });
  });

  test("reuses one OTLP exporter while resolving fresh auth headers per trace", async () => {
    const { host } = await startBackend();
    const client = createClient(host, [
      "trace-1",
      "otel-1",
      "trace-2",
      "otel-2",
    ]);
    const first = await createTraceSpans();
    const second = await createTraceSpans();
    const observedHeaders: Record<string, string>[] = [];
    const shutdown = vi.fn().mockResolvedValue(undefined);
    let exporterCreations = 0;
    const exporter = new MlflowUcSpanExporter(config, client, {
      createOtlpExporter(options) {
        exporterCreations += 1;
        return {
          export(_spans, callback) {
            const headers = options.headers as
              | Record<string, string>
              | (() => Promise<Record<string, string>>);
            void Promise.resolve(
              typeof headers === "function" ? headers() : headers,
            ).then((resolved) => {
              observedHeaders.push(resolved);
              callback({ code: ExportResultCode.SUCCESS });
            });
          },
          shutdown,
        } satisfies SpanExporter;
      },
    });

    await expect(exportSpans(exporter, first)).resolves.toMatchObject({
      code: ExportResultCode.SUCCESS,
    });
    await expect(exportSpans(exporter, second)).resolves.toMatchObject({
      code: ExportResultCode.SUCCESS,
    });
    await exporter.shutdown();

    expect(exporterCreations).toBe(1);
    expect(observedHeaders).toEqual([
      {
        authorization: "Bearer otel-1",
        "X-Databricks-UC-Table-Name": "main.agent_traces.appkit_otel_spans",
      },
      {
        authorization: "Bearer otel-2",
        "X-Databricks-UC-Table-Name": "main.agent_traces.appkit_otel_spans",
      },
    ]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  test("retries a transient trace-info rejection and succeeds", async () => {
    let attempts = 0;
    const { host } = await startBackend((request, response) => {
      if (request.path.endsWith("/info")) attempts += 1;
      response.statusCode = attempts === 1 ? 500 : 200;
      response.end(attempts === 1 ? "backend unavailable" : "");
    });
    const client = createClient(host, ["token-1", "token-2", "token-3"]);
    const spans = await createTraceSpans();
    const exporter = new MlflowUcSpanExporter(config, client, {
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    await expect(exportSpans(exporter, spans)).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(attempts).toBe(2);
  });

  test("does not retry a non-retryable OTLP client error", async () => {
    const { host } = await startBackend();
    const client = createClient(host, ["token-1"]);
    const spans = await createTraceSpans();
    let attempts = 0;
    const exporter = new MlflowUcSpanExporter(config, client, {
      maxAttempts: 3,
      retryDelayMs: 0,
      createOtlpExporter() {
        return {
          export(_spans, callback) {
            attempts += 1;
            callback({
              code: ExportResultCode.FAILED,
              error: Object.assign(new Error("bad request"), {
                name: "OTLPExporterError",
                code: 400,
              }),
            });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    await expect(exportSpans(exporter, spans)).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
    });
    expect(attempts).toBe(1);
  });

  test("reports a persistent backend rejection as failed and logs one structured error", async () => {
    const { host, requests } = await startBackend((_request, response) => {
      response.statusCode = 500;
      response.end("backend unavailable");
    });
    const logger = { error: vi.fn() };
    const client = createClient(host, ["token-1"]);
    const spans = await createTraceSpans();
    const exporter = new MlflowUcSpanExporter(config, client, {
      logger,
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    await expect(exportSpans(exporter, spans)).resolves.toEqual({
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });
    expect(requests).toHaveLength(2);
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
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });
    expect(logger.error).toHaveBeenCalledWith(
      "MLflow UC trace export failed: %O",
      expect.objectContaining({
        error: "Databricks workspace host is unavailable for MLflow UC export",
      }),
    );
  });

  test("bounds a hung trace-info request and reports failure", async () => {
    const { host } = await startBackend(async (request, response) => {
      if (request.path.endsWith("/info")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      response.statusCode = 200;
      response.end();
    });
    const client = createClient(host, ["token-1", "token-2"]);
    const spans = await createTraceSpans();
    const exporter = new MlflowUcSpanExporter(config, client, {
      maxAttempts: 1,
      operationTimeoutMs: 25,
    });
    const started = Date.now();

    await expect(exportSpans(exporter, spans)).resolves.toEqual({
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });
    await exporter.forceFlush();
    expect(Date.now() - started).toBeLessThan(80);
  });

  test("bounds workspace authentication before any trace request begins", async () => {
    const client = {
      config: {
        host: "http://127.0.0.1:1",
        ensureResolved: vi.fn().mockResolvedValue(undefined),
        authenticate: vi.fn(() => new Promise<void>(() => undefined)),
      },
    } as unknown as WorkspaceClient;
    const spans = await createTraceSpans();
    const exporter = new MlflowUcSpanExporter(config, client, {
      maxAttempts: 1,
      operationTimeoutMs: 25,
    });

    const result = await Promise.race([
      exportSpans(exporter, spans),
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), 100),
      ),
    ]);

    expect(result).toMatchObject({
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });
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

  test("shutdown drains every trace accepted by an active multi-trace export driver", async () => {
    const firstTrace = await createTraceSpans();
    const secondTrace = await createTraceSpans();
    const lateTrace = await createTraceSpans();
    const firstTraceId = firstTrace[0].spanContext().traceId;
    const secondTraceId = secondTrace[0].spanContext().traceId;
    const lateTraceId = lateTrace[0].spanContext().traceId;
    const events: Array<{ kind: "trace-info" | "otlp"; traceId: string }> = [];

    let releaseFirstTraceInfo!: () => void;
    const firstTraceInfoReleased = new Promise<void>((resolve) => {
      releaseFirstTraceInfo = resolve;
    });
    let firstTraceInfoStarted!: () => void;
    const firstTraceInfoObserved = new Promise<void>((resolve) => {
      firstTraceInfoStarted = resolve;
    });
    let finishSecondUpload!: () => void;
    const secondUploadFinished = new Promise<void>((resolve) => {
      finishSecondUpload = resolve;
    });
    let secondUploadStarted!: () => void;
    const secondUploadObserved = new Promise<void>((resolve) => {
      secondUploadStarted = resolve;
    });

    const { host } = await startBackend(async (request, response) => {
      const traceId = request.path.match(/\/([0-9a-f]{32})\/info$/)?.[1];
      if (traceId) events.push({ kind: "trace-info", traceId });
      if (traceId === firstTraceId) {
        firstTraceInfoStarted();
        await firstTraceInfoReleased;
      }
      response.statusCode = 200;
      response.end();
    });
    const client = createClient(host, [
      "token-1",
      "token-2",
      "token-3",
      "token-4",
    ]);
    const exporter = new MlflowUcSpanExporter(config, client, {
      createOtlpExporter() {
        return {
          export(spans, callback) {
            const traceId = spans[0].spanContext().traceId;
            events.push({ kind: "otlp", traceId });
            if (traceId === secondTraceId) {
              secondUploadStarted();
              void secondUploadFinished.then(() =>
                callback({ code: ExportResultCode.SUCCESS }),
              );
              return;
            }
            callback({ code: ExportResultCode.SUCCESS });
          },
          shutdown: vi.fn().mockResolvedValue(undefined),
        } satisfies SpanExporter;
      },
    });

    const activeExport = exportSpans(exporter, [...firstTrace, ...secondTrace]);
    await firstTraceInfoObserved;
    let shutdownComplete = false;
    const shutdown = exporter.shutdown().then(() => {
      shutdownComplete = true;
    });
    await expect(exportSpans(exporter, lateTrace)).resolves.toEqual({
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    releaseFirstTraceInfo();
    const secondAcceptedTraceStarted = await Promise.race([
      secondUploadObserved.then(() => true),
      activeExport.then(() => false),
    ]);
    expect(secondAcceptedTraceStarted).toBe(true);
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    finishSecondUpload();
    await Promise.all([activeExport, shutdown]);
    expect(events).toEqual([
      { kind: "trace-info", traceId: firstTraceId },
      { kind: "otlp", traceId: firstTraceId },
      { kind: "trace-info", traceId: secondTraceId },
      { kind: "otlp", traceId: secondTraceId },
    ]);
    expect(events.some((event) => event.traceId === lateTraceId)).toBe(false);
  });
});
