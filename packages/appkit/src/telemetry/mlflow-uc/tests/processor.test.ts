import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, test, vi } from "vitest";
import {
  getMlflowUcTraceId,
  type MlflowUcConfig,
  MlflowUcSpanProcessor,
  MlflowUcTraceRegistry,
} from "../../index";
import type { MlflowUcExportBatch, MlflowUcTraceExporter } from "../exporter";
import { setActiveMlflowUcTraceRegistry } from "../index";

const config: MlflowUcConfig = {
  experimentId: "experiment-123",
  catalogName: "main",
  schemaName: "agent_traces",
  tablePrefix: "appkit",
  otelSpansTableName: "main.agent_traces.appkit_otel_spans",
};

function collectingExporter(
  onExport?: (
    batch: MlflowUcExportBatch,
    callback: (result: { code: ExportResultCode; error?: Error }) => void,
  ) => void,
) {
  const batches: MlflowUcExportBatch[] = [];
  const exporter: MlflowUcTraceExporter = {
    exportTrace(batch, callback) {
      batches.push(batch);
      if (onExport) onExport(batch, callback);
      else callback({ code: ExportResultCode.SUCCESS });
    },
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  return { exporter, batches };
}

function startTree(processor: MlflowUcSpanProcessor) {
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("mlflow-uc-processor-test");
  const http = tracer.startSpan("POST /api/agents/chat");
  const agent = tracer.startSpan(
    "support-agent",
    {
      attributes: {
        "mlflow.spanType": "AGENT",
        "mlflow.spanInputs": '{"prompt":"hello"}',
        "mlflow.spanOutputs": '{"answer":"world"}',
        "mlflow.trace.session": "session-1",
        "mlflow.trace.user": "user-1",
        "mlflow.sourceRun": "run-99",
        "appkit.app.name": "support-console",
        "appkit.request.id": "request-1",
        "appkit.thread.id": "thread-1",
        "appkit.agent.name": "support-agent",
        "appkit.route": "chat",
      },
    },
    trace.setSpan(context.active(), http),
  );
  const model = tracer.startSpan(
    "model-step",
    {
      attributes: {
        "mlflow.spanType": "CHAT_MODEL",
        "mlflow.chat.tokenUsage":
          '{"input_tokens":4,"output_tokens":2,"total_tokens":6,"cache_read_input_tokens":1}',
      },
    },
    trace.setSpan(context.active(), agent),
  );
  return { provider, http, agent, model };
}

describe("MlflowUcSpanProcessor", () => {
  test("exposes the active registry's V4 trace ID to root tracing", () => {
    const registry = new MlflowUcTraceRegistry(config);
    const otelTraceId = "0123456789abcdef0123456789abcdef";
    setActiveMlflowUcTraceRegistry(registry);
    try {
      registry.ensureTrace(otelTraceId);
      expect(getMlflowUcTraceId(otelTraceId)).toBe(
        `trace:/main.agent_traces.appkit/${otelTraceId}`,
      );
    } finally {
      setActiveMlflowUcTraceRegistry(undefined);
    }
  });

  test("uses the semantic AGENT as MLflow root and exports its complete tree only when it ends", async () => {
    const registry = new MlflowUcTraceRegistry(config);
    const { exporter, batches } = collectingExporter();
    const processor = new MlflowUcSpanProcessor(config, exporter, registry);
    const { provider, http, agent, model } = startTree(processor);
    const otelTraceId = agent.spanContext().traceId;
    const mlflowTraceId =
      `trace:/main.agent_traces.appkit/${otelTraceId}` as const;

    expect(registry.getMlflowTraceId(otelTraceId)).toBe(mlflowTraceId);

    model.end();
    expect(batches).toHaveLength(0);

    agent.setStatus({ code: SpanStatusCode.OK });
    agent.end();
    expect(batches).toHaveLength(1);
    expect(batches[0].spans.map((span: ReadableSpan) => span.name)).toEqual([
      "model-step",
      "support-agent",
    ]);
    expect(batches[0].traceInfo).toMatchObject({
      trace_id: mlflowTraceId,
      client_request_id: "request-1",
      request_preview: '{"prompt":"hello"}',
      response_preview: '{"answer":"world"}',
      state: "OK",
      trace_metadata: {
        "mlflow.trace_schema.version": "4",
        "mlflow.trace.tokenUsage":
          '{"input_tokens":4,"output_tokens":2,"total_tokens":6,"cache_read_input_tokens":1}',
        "mlflow.sourceRun": "run-99",
        "appkit.app.name": "support-console",
      },
    });

    const exportedRoot = batches[0].spans.find(
      (span) => span.name === "support-agent",
    );
    expect(exportedRoot?.parentSpanContext?.spanId).toBe(
      http.spanContext().spanId,
    );
    for (const span of batches[0].spans) {
      expect(span.attributes["mlflow.traceRequestId"]).toBe(mlflowTraceId);
      expect(span.attributes["mlflow.experimentId"]).toBe("experiment-123");
    }

    http.end();
    expect(batches).toHaveLength(1);
    await provider.shutdown();
  });

  test("releases completed trace state when later non-root work ends", async () => {
    const registry = new MlflowUcTraceRegistry(config);
    const { exporter, batches } = collectingExporter();
    const processor = new MlflowUcSpanProcessor(config, exporter, registry);
    const { provider, http, agent, model } = startTree(processor);
    const otelTraceId = agent.spanContext().traceId;

    model.end();
    agent.end();

    const tracer = provider.getTracer("late-non-root-test");
    const lateSpan = tracer.startSpan(
      "late-http-work",
      { attributes: { "mlflow.spanType": "CHAIN" } },
      trace.setSpan(context.active(), http),
    );
    lateSpan.end();

    expect(batches).toHaveLength(1);
    expect(registry.getSemanticRootSpanId(otelTraceId)).toBeUndefined();
    expect(registry.getMlflowTraceId(otelTraceId)).toBeUndefined();

    http.end();
    await provider.shutdown();
  });

  test("forceFlush waits for the root export callback", async () => {
    let finishExport!: () => void;
    const { exporter } = collectingExporter((_batch, callback) => {
      finishExport = () => callback({ code: ExportResultCode.SUCCESS });
    });
    const processor = new MlflowUcSpanProcessor(config, exporter);
    const { provider, http, agent, model } = startTree(processor);
    model.end();
    agent.end();

    let flushed = false;
    const forceFlush = processor.forceFlush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    finishExport();
    await forceFlush;
    expect(flushed).toBe(true);

    http.end();
    await provider.shutdown();
  });

  test("keeps nested AGENT spans inside the first semantic root", async () => {
    const { exporter, batches } = collectingExporter();
    const processor = new MlflowUcSpanProcessor(config, exporter);
    const { provider, http, agent, model } = startTree(processor);
    const tracer = provider.getTracer("nested-agent-test");
    const nestedAgent = tracer.startSpan(
      "helper-agent",
      { attributes: { "mlflow.spanType": "AGENT" } },
      trace.setSpan(context.active(), agent),
    );
    const nestedTool = tracer.startSpan(
      "helper-tool",
      { attributes: { "mlflow.spanType": "TOOL" } },
      trace.setSpan(context.active(), nestedAgent),
    );

    nestedTool.end();
    nestedAgent.end();
    model.end();
    agent.end();

    expect(batches).toHaveLength(1);
    expect(batches[0].spans.map((span) => span.name)).toEqual([
      "helper-tool",
      "helper-agent",
      "model-step",
      "support-agent",
    ]);

    http.end();
    await provider.shutdown();
  });

  test("exports every concurrently active semantic root beyond the former registry capacity", async () => {
    const { exporter, batches } = collectingExporter();
    const processor = new MlflowUcSpanProcessor(config, exporter);
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("registry-capacity-test");
    const roots = Array.from({ length: 10_001 }, (_, index) =>
      tracer.startSpan(`agent-${index}`, {
        attributes: { "mlflow.spanType": "AGENT" },
      }),
    );

    for (const root of roots) root.end();
    await processor.forceFlush();

    expect(batches).toHaveLength(10_001);
    expect(new Set(batches.map((batch) => batch.traceInfo.trace_id)).size).toBe(
      10_001,
    );

    await provider.shutdown();
  }, 15_000);
});
