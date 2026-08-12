import {
  context,
  createTraceState,
  propagation,
  type Span,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  MlflowUcTraceRegistry,
  setActiveMlflowUcTraceRegistry,
} from "../../mlflow-uc";
import * as agentTracing from "../index";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";
const REMOTE_SPAN_ID = "fedcba9876543210";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
const TRACESTATE = "vendor=value";

interface RemoteTraceReference {
  traceId: string;
  otelTraceId: string;
  spanId: string;
  source: "model-serving" | "supervisor" | "mcp" | "remote-agent";
}

const injectActiveTraceContext = (
  agentTracing as unknown as {
    injectActiveTraceContext: (headers: Headers) => Headers;
  }
).injectActiveTraceContext;

const attachRemoteTraceLink = (
  agentTracing as unknown as {
    attachRemoteTraceLink: (
      span: Span,
      reference: RemoteTraceReference,
    ) => void;
  }
).attachRemoteTraceLink;

beforeAll(() => {
  context.disable();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.disable();
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterEach(() => {
  setActiveMlflowUcTraceRegistry(undefined);
});

afterAll(() => {
  propagation.disable();
  context.disable();
});

function withKnownActiveSpan<T>(operation: () => T): T {
  const span = trace.wrapSpanContext({
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    traceState: createTraceState(TRACESTATE),
  });
  return context.with(trace.setSpan(context.active(), span), operation);
}

describe("agent trace propagation", () => {
  test("replaces stale W3C headers with the exact active sampled context and preserves other headers", () => {
    withKnownActiveSpan(() => {
      const headers = new Headers({
        Authorization: "Bearer secret",
        "X-AppKit-Request": "request-1",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
        tracestate: "stale=value",
      });

      const result = injectActiveTraceContext(headers);

      expect(result).toBe(headers);
      expect(result.get("traceparent")).toBe(TRACEPARENT);
      expect(result.get("tracestate")).toBe(TRACESTATE);
      expect(result.get("authorization")).toBe("Bearer secret");
      expect(result.get("x-appkit-request")).toBe("request-1");
    });
  });

  test("removes stale W3C headers when there is no valid active span", () => {
    const headers = new Headers({
      Authorization: "Bearer secret",
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });

    const result = injectActiveTraceContext(headers);

    expect(result.get("traceparent")).toBeNull();
    expect(result.get("tracestate")).toBeNull();
    expect(result.get("authorization")).toBe("Bearer secret");
  });

  test("adds one validated cross-location link and skips same-location continuation", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const registry = new MlflowUcTraceRegistry({
      experimentId: "experiment-1",
      catalogName: "main",
      schemaName: "agent_traces",
      tablePrefix: "appkit",
      otelSpansTableName: "main.agent_traces.appkit_otel_spans",
    });
    setActiveMlflowUcTraceRegistry(registry);

    await provider
      .getTracer("propagation-test")
      .startActiveSpan(
        "remote_lookup tool",
        { attributes: { "mlflow.spanType": "TOOL" } },
        async (span) => {
          const otelTraceId = span.spanContext().traceId;
          const currentTraceId = registry.ensureTrace(otelTraceId);
          attachRemoteTraceLink(span, {
            traceId: currentTraceId,
            otelTraceId,
            spanId: SPAN_ID,
            source: "mcp",
          });
          attachRemoteTraceLink(span, {
            traceId: `trace:/other.remote.agent/${otelTraceId}`,
            otelTraceId,
            spanId: REMOTE_SPAN_ID,
            source: "mcp",
          });
          span.end();
        },
      );

    await provider.forceFlush();
    const tool = exporter.getFinishedSpans()[0];
    expect(tool.links).toHaveLength(1);
    expect(tool.links[0].context).toMatchObject({
      traceId: tool.spanContext().traceId,
      spanId: REMOTE_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
    });
    expect(tool.links[0].attributes).toEqual({
      "appkit.remote_trace.source": "mcp",
      "mlflow.traceRequestId": `trace:/other.remote.agent/${tool.spanContext().traceId}`,
    });

    await provider.shutdown();
  });

  test("ignores malformed MLflow, OTel trace, and span IDs", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    await provider
      .getTracer("propagation-test")
      .startActiveSpan(
        "remote_lookup tool",
        { attributes: { "mlflow.spanType": "TOOL" } },
        async (span) => {
          const references: RemoteTraceReference[] = [
            {
              traceId: `trace:/other.remote.agent/${TRACE_ID}`,
              otelTraceId: "not-a-trace-id",
              spanId: REMOTE_SPAN_ID,
              source: "mcp",
            },
            {
              traceId: `trace:/other.remote.agent/${TRACE_ID}`,
              otelTraceId: TRACE_ID,
              spanId: "not-a-span-id",
              source: "mcp",
            },
            {
              traceId: `trace:/other.remote.agent/${"a".repeat(32)}`,
              otelTraceId: TRACE_ID,
              spanId: REMOTE_SPAN_ID,
              source: "mcp",
            },
            {
              traceId: `trace:/other.remote.agent/${TRACE_ID.toUpperCase()}`,
              otelTraceId: TRACE_ID,
              spanId: REMOTE_SPAN_ID,
              source: "mcp",
            },
          ];
          for (const reference of references) {
            attachRemoteTraceLink(span, reference);
          }
          span.end();
        },
      );

    await provider.forceFlush();
    expect(exporter.getFinishedSpans()[0].links).toEqual([]);
    await provider.shutdown();
  });
});
