import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { AgentEvent, AgentUsage } from "shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  type MlflowUcConfig,
  MlflowUcSpanProcessor,
  MlflowUcTraceRegistry,
  setActiveMlflowUcTraceRegistry,
} from "../../mlflow-uc";
import * as agentTracing from "../index";

type AgentTraceRoute = "chat" | "invocations" | "responses" | "runAgent";

interface AgentTraceIdentity {
  appName: string;
  agentName: string;
  route: AgentTraceRoute;
  sessionId: string;
  userId: string;
  requestId: string;
  threadId: string;
}

interface AgentTraceObserver {
  readonly traceId: string;
  onEvent(event: AgentEvent): void;
  updateIdentity(identity: Partial<Omit<AgentTraceIdentity, "route">>): void;
  setOutput(output: unknown): void;
  recordError(error: unknown, output?: unknown): void;
}

type RunWithAgentTrace = <T>(
  identity: AgentTraceIdentity,
  inputs: unknown,
  operation: (observer: AgentTraceObserver) => Promise<T>,
) => Promise<{ value: T; traceId: string; usage: AgentUsage }>;

// Intentionally reaches through the existing public module so RED is a
// behavioral failure (the helper is absent), not a module-resolution error.
const runWithAgentTrace = (
  agentTracing as unknown as {
    runWithAgentTrace: RunWithAgentTrace;
  }
).runWithAgentTrace;

const mlflowConfig: MlflowUcConfig = {
  experimentId: "experiment-123",
  catalogName: "main",
  schemaName: "agent_traces",
  tablePrefix: "appkit",
  otelSpansTableName: "main.agent_traces.appkit_otel_spans",
};

let provider: BasicTracerProvider | undefined;
let exporter: InMemorySpanExporter | undefined;
let getTracerSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
  context.disable();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
});

afterEach(async () => {
  getTracerSpy?.mockRestore();
  getTracerSpy = undefined;
  setActiveMlflowUcTraceRegistry(undefined);
  await provider?.shutdown();
  provider = undefined;
  exporter = undefined;
});

afterAll(() => {
  context.disable();
});

function installTracing(extraProcessors: SpanProcessor[] = []): void {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter), ...extraProcessors],
  });
  const installedProvider = provider;
  getTracerSpy = vi
    .spyOn(trace, "getTracer")
    .mockImplementation((name: string, version?: string) =>
      installedProvider.getTracer(name, version),
    );
}

function identity(route: AgentTraceRoute): AgentTraceIdentity {
  return {
    appName: "support-console",
    agentName: "planner",
    route,
    sessionId: "session-1",
    userId: "user-1",
    requestId: "request-1",
    threadId: "thread-1",
  };
}

function modelEvents(
  options: { costAvailable?: boolean; costUsd?: number; error?: string } = {},
): AgentEvent[] {
  const startedAt = Date.now() - 50;
  const costAvailable = options.costAvailable ?? true;
  return [
    {
      type: "model_start",
      stepId: "step-1",
      model: "dbx-claude-sonnet",
      provider: "databricks",
      input: { messages: [{ role: "user", content: "Hello" }] },
      startedAt,
    },
    { type: "message_delta", content: "Hello " },
    { type: "message_delta", content: "world" },
    {
      type: "model_end",
      stepId: "step-1",
      model: "dbx-claude-sonnet",
      provider: "databricks",
      output: { text: "Hello world" },
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        totalTokens: 9,
        cacheReadInputTokens: 3,
        ...(options.costUsd !== undefined
          ? { costUsd: options.costUsd }
          : costAvailable
            ? { costUsd: 0.0125 }
            : {}),
        costAvailable,
      },
      finishReason: options.error ? "error" : "stop",
      firstTokenAt: startedAt + 12,
      streamDurationMs: 40,
      endedAt: startedAt + 50,
      ...(options.error ? { error: options.error } : {}),
    },
  ];
}

async function executeGoldenTrace(route: AgentTraceRoute) {
  if (!provider) throw new Error("Tracing is not installed");
  const operation = async (observer: AgentTraceObserver) => {
    for (const event of modelEvents()) observer.onEvent(event);
    return { text: "Hello world" };
  };

  if (route === "runAgent") {
    return {
      traced: await runWithAgentTrace(
        identity(route),
        { messages: [{ role: "user", content: "Hello" }] },
        operation,
      ),
      httpSpanId: undefined,
    };
  }

  const http = provider.getTracer("http-test").startSpan(`POST /${route}`, {
    attributes: { "http.request.method": "POST" },
  });
  try {
    const traced = await context.with(
      trace.setSpan(context.active(), http),
      () =>
        runWithAgentTrace(
          identity(route),
          { messages: [{ role: "user", content: "Hello" }] },
          operation,
        ),
    );
    return { traced, httpSpanId: http.spanContext().spanId };
  } finally {
    http.end();
  }
}

function finishedSpans(): ReadableSpan[] {
  return exporter?.getFinishedSpans() ?? [];
}

describe("runWithAgentTrace golden span trees", () => {
  test.each<AgentTraceRoute>(["chat", "invocations", "responses", "runAgent"])(
    "creates one semantic AGENT root and one exact model child for %s",
    async (route) => {
      installTracing();

      const { traced, httpSpanId } = await executeGoldenTrace(route);
      const spans = finishedSpans();
      const roots = spans.filter(
        (span) => span.attributes["mlflow.spanType"] === "AGENT",
      );
      const models = spans.filter(
        (span) => span.attributes["mlflow.spanType"] === "CHAT_MODEL",
      );

      expect(roots).toHaveLength(1);
      expect(models).toHaveLength(1);
      const root = roots[0];
      const model = models[0];
      expect(root.attributes).toMatchObject({
        "mlflow.spanType": "AGENT",
        "mlflow.spanInputs": '{"messages":[{"content":"Hello","role":"user"}]}',
        "mlflow.spanOutputs": '{"text":"Hello world"}',
        "mlflow.trace.session": "session-1",
        "mlflow.trace.user": "user-1",
        "appkit.app.name": "support-console",
        "appkit.request.id": "request-1",
        "appkit.thread.id": "thread-1",
        "appkit.agent.name": "planner",
        "appkit.route": route,
        "mlflow.trace.tokenUsage":
          '{"cache_read_input_tokens":3,"input_tokens":7,"output_tokens":2,"total_tokens":9}',
        "appkit.cost.available": true,
        "mlflow.llm.cost": 0.0125,
      });
      expect(root.status.code).toBe(SpanStatusCode.OK);
      expect(
        root.duration[0] * 1_000_000_000 + root.duration[1],
      ).toBeGreaterThanOrEqual(0);
      expect(model.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(model.attributes).toMatchObject({
        "mlflow.spanType": "CHAT_MODEL",
        "gen_ai.operation.name": "chat",
        "mlflow.spanInputs": '{"messages":[{"content":"Hello","role":"user"}]}',
        "mlflow.spanOutputs": '{"text":"Hello world"}',
        "mlflow.chat.model": "dbx-claude-sonnet",
        "mlflow.chat.provider": "databricks",
        "mlflow.chat.tokenUsage":
          '{"cache_read_input_tokens":3,"input_tokens":7,"output_tokens":2,"total_tokens":9}',
        "gen_ai.usage.input_tokens": 7,
        "gen_ai.usage.output_tokens": 2,
        "gen_ai.usage.cache_read_input_tokens": 3,
        "gen_ai.response.model": "dbx-claude-sonnet",
        "gen_ai.response.time_to_first_token_ms": 12,
        "gen_ai.response.stream_duration_ms": 40,
        "appkit.cache.read_input_tokens": 3,
        "appkit.first_token.duration_ms": 12,
        "appkit.stream.duration_ms": 40,
        "appkit.cost.available": true,
        "mlflow.llm.cost": 0.0125,
      });
      expect(model.attributes["gen_ai.response.finish_reasons"]).toEqual([
        "stop",
      ]);
      expect(model.status.code).toBe(SpanStatusCode.OK);
      expect(traced.value).toEqual({ text: "Hello world" });
      expect(traced.usage).toEqual({
        inputTokens: 7,
        outputTokens: 2,
        totalTokens: 9,
        cacheReadInputTokens: 3,
        costUsd: 0.0125,
        costAvailable: true,
      });
      expect(traced.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(traced.traceId).not.toBe(httpSpanId);
      expect(root.parentSpanContext?.spanId).toBe(httpSpanId);
    },
  );

  test("exposes the UC V4 root trace ID synchronously before the operation writes", async () => {
    const registry = new MlflowUcTraceRegistry(mlflowConfig);
    const ucProcessor = new MlflowUcSpanProcessor(
      mlflowConfig,
      {
        exportTrace: (_batch, callback) => callback({ code: 0 }),
        forceFlush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
      registry,
    );
    setActiveMlflowUcTraceRegistry(registry);
    installTracing([ucProcessor]);
    const order: string[] = [];
    let observedTraceId = "";

    const traced = await runWithAgentTrace(
      identity("chat"),
      { message: "hello" },
      async (observer) => {
        observedTraceId = observer.traceId;
        order.push(`trace:${observer.traceId}`);
        await Promise.resolve();
        order.push("body-write");
        observer.onEvent({ type: "message", content: "done" });
        return { text: "done" };
      },
    );

    expect(order[0]).toBe(`trace:${observedTraceId}`);
    expect(order[1]).toBe("body-write");
    expect(observedTraceId).toMatch(
      /^trace:\/main\.agent_traces\.appkit\/[0-9a-f]{32}$/,
    );
    expect(traced.traceId).toBe(observedTraceId);
  });

  test("exports a verified linked remote model trace and rejects unverified continuation", async () => {
    installTracing();
    const remoteTraceId =
      "trace:/main.agent_traces.remote/11111111111111111111111111111111";

    await runWithAgentTrace(
      identity("responses"),
      { message: "delegate" },
      async (observer) => {
        const [start, ...rest] = modelEvents();
        observer.onEvent(start);
        observer.onEvent({
          type: "remote_trace",
          traceId: remoteTraceId,
          spanId: "2222222222222222",
          source: "model-serving",
          relation: "linked",
        });
        observer.onEvent({
          type: "remote_trace",
          traceId: "trace:/main.agent_traces.remote/unverified",
          source: "model-serving",
          relation: "continued",
        });
        for (const event of rest) observer.onEvent(event);
        return { text: "done" };
      },
    );

    const model = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "CHAT_MODEL",
    );
    expect(model?.links).toHaveLength(1);
    expect(model?.links[0]?.context).toMatchObject({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
    });
    expect(model?.links[0]?.attributes).toMatchObject({
      "mlflow.traceRequestId": remoteTraceId,
      "appkit.remote_trace.source": "model-serving",
    });
  });

  test("keeps the fallback trace ID active when no tracer provider is installed", async () => {
    let activeTraceId: string | undefined;

    const traced = await runWithAgentTrace(
      identity("runAgent"),
      { message: "local" },
      async (observer) => {
        activeTraceId = trace.getActiveSpan()?.spanContext().traceId;
        expect(observer.traceId).toMatch(/^[0-9a-f]{32}$/);
        observer.onEvent({ type: "message", content: "done" });
        return { text: "done" };
      },
    );

    expect(activeTraceId).toBe(traced.traceId);
  });

  test("finalizes partial output, model child, exception, and root exactly once on throw", async () => {
    installTracing();
    const secretError = new Error("Authorization: Bearer top-secret-token");

    await expect(
      runWithAgentTrace(
        identity("responses"),
        { password: "secret" },
        async (observer) => {
          const [start] = modelEvents();
          observer.onEvent(start);
          observer.onEvent({ type: "message_delta", content: "partial" });
          throw secretError;
        },
      ),
    ).rejects.toBe(secretError);

    const root = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "AGENT",
    );
    const model = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "CHAT_MODEL",
    );
    expect(root).toBeDefined();
    expect(model).toBeDefined();
    expect(root?.attributes["mlflow.spanInputs"]).toBe(
      '{"password":"[REDACTED]"}',
    );
    expect(root?.attributes["mlflow.spanOutputs"]).toBe(
      '{"error":"[REDACTED]","partial_output":"partial"}',
    );
    expect(model?.attributes["mlflow.spanOutputs"]).toBe(
      '{"error":"[REDACTED]","partial_output":{"text":"partial"}}',
    );
    expect(root?.status.code).toBe(SpanStatusCode.ERROR);
    expect(model?.status.code).toBe(SpanStatusCode.ERROR);
    expect(
      root?.events.filter((event) => event.name === "exception"),
    ).toHaveLength(1);
    expect(JSON.stringify(root?.events)).not.toContain("top-secret-token");
    expect(JSON.stringify(model?.events)).not.toContain("top-secret-token");
  });

  test("never exposes a custom Error name through root or model exception.type", async () => {
    installTracing();
    const secret = "adapter-secret-name";
    const customError = new Error("Authorization: Bearer message-secret");
    customError.name = `${secret}-${"x".repeat(2_048)}`;

    await expect(
      runWithAgentTrace(
        identity("responses"),
        { message: "hello" },
        async (observer) => {
          for (const event of modelEvents({ error: `${secret}-model` })) {
            observer.onEvent(event);
          }
          throw customError;
        },
      ),
    ).rejects.toBe(customError);

    const exceptionEvents = finishedSpans().flatMap((span) =>
      span.events.filter((event) => event.name === "exception"),
    );
    expect(exceptionEvents).toHaveLength(2);
    for (const event of exceptionEvents) {
      expect(event.attributes?.["exception.type"]).toBe("Error");
      expect(
        String(event.attributes?.["exception.type"]).length,
      ).toBeLessThanOrEqual(64);
    }
    expect(JSON.stringify(exceptionEvents)).not.toContain(secret);
    expect(JSON.stringify(exceptionEvents)).not.toContain("message-secret");
  });

  test("records an aborted partial stream as error and omits unavailable aggregate cost", async () => {
    installTracing();
    const abortError = new DOMException("client cancelled", "AbortError");

    await expect(
      runWithAgentTrace(
        identity("chat"),
        { message: "hello" },
        async (observer) => {
          for (const event of modelEvents({ costAvailable: false })) {
            observer.onEvent(event);
            if (event.type === "message_delta") break;
          }
          throw abortError;
        },
      ),
    ).rejects.toBe(abortError);

    const root = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "AGENT",
    );
    expect(root?.attributes["mlflow.spanOutputs"]).toBe(
      '{"error":"[REDACTED]","partial_output":"Hello "}',
    );
    expect(root?.attributes["appkit.cost.available"]).toBe(false);
    expect(root?.attributes["mlflow.llm.cost"]).toBeUndefined();
    expect(root?.status.code).toBe(SpanStatusCode.ERROR);
  });

  test("records a root exception when model lifecycle reports an error without throwing", async () => {
    installTracing();

    const traced = await runWithAgentTrace(
      identity("responses"),
      { message: "hello" },
      async (observer) => {
        for (const event of modelEvents({ error: "token=provider-secret" })) {
          observer.onEvent(event);
        }
        return { text: "Hello world" };
      },
    );

    const root = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "AGENT",
    );
    expect(traced.value).toEqual({ text: "Hello world" });
    expect(root?.status.code).toBe(SpanStatusCode.ERROR);
    expect(
      root?.events.filter((event) => event.name === "exception"),
    ).toHaveLength(1);
    expect(JSON.stringify(root?.events)).not.toContain("provider-secret");
  });

  test("redacts explicit handled-error output when the operation does not throw", async () => {
    installTracing();
    const secret = "adapter-error-secret";

    await runWithAgentTrace(
      identity("invocations"),
      { message: "hello" },
      async (observer) => {
        observer.recordError(new Error(secret), {
          error: secret,
          trace_id: "trace-123",
        });
      },
    );

    const root = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "AGENT",
    );
    expect(root?.status.code).toBe(SpanStatusCode.ERROR);
    expect(root?.attributes["mlflow.spanOutputs"]).toBe(
      '{"error":"[REDACTED]","partial_output":{"trace_id":"trace-123"}}',
    );
    expect(JSON.stringify(root?.events)).not.toContain(secret);
  });

  test("counts each model_end once and withholds partial aggregate cost", async () => {
    installTracing();

    const traced = await runWithAgentTrace(
      identity("invocations"),
      { message: "hello" },
      async (observer) => {
        const priced = modelEvents({ costUsd: 0.01 });
        for (const event of priced) observer.onEvent(event);
        const pricedEnd = priced.at(-1);
        if (!pricedEnd) throw new Error("Missing priced model_end fixture");
        observer.onEvent(pricedEnd);
        for (const event of modelEvents({ costAvailable: false }).map(
          (event) =>
            "stepId" in event ? { ...event, stepId: "step-2" } : event,
        )) {
          observer.onEvent(event);
        }
        return { text: "Hello world" };
      },
    );

    expect(traced.usage).toEqual({
      inputTokens: 14,
      outputTokens: 4,
      totalTokens: 18,
      cacheReadInputTokens: 6,
      costAvailable: false,
    });
    const root = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "AGENT",
    );
    expect(root?.attributes["appkit.cost.available"]).toBe(false);
    expect(root?.attributes["mlflow.llm.cost"]).toBeUndefined();
    expect(
      finishedSpans().filter(
        (span) => span.attributes["mlflow.spanType"] === "CHAT_MODEL",
      ),
    ).toHaveLength(2);
  });

  test("treats costAvailable without costUsd as unavailable for child and root", async () => {
    installTracing();

    const traced = await runWithAgentTrace(
      identity("invocations"),
      { message: "hello" },
      async (observer) => {
        for (const event of modelEvents({
          costAvailable: true,
          costUsd: undefined,
        })) {
          if (event.type === "model_end") {
            observer.onEvent({
              ...event,
              usage: {
                inputTokens: 7,
                outputTokens: 2,
                totalTokens: 9,
                costAvailable: true,
              },
            });
          } else {
            observer.onEvent(event);
          }
        }
        return { text: "Hello world" };
      },
    );

    const root = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "AGENT",
    );
    const model = finishedSpans().find(
      (span) => span.attributes["mlflow.spanType"] === "CHAT_MODEL",
    );
    expect(traced.usage.costAvailable).toBe(false);
    expect(root?.attributes["appkit.cost.available"]).toBe(false);
    expect(root?.attributes["mlflow.llm.cost"]).toBeUndefined();
    expect(model?.attributes["appkit.cost.available"]).toBe(false);
    expect(model?.attributes["mlflow.llm.cost"]).toBeUndefined();
  });

  test("retains a legitimate zero cost as available for child and root", async () => {
    installTracing();

    const traced = await runWithAgentTrace(
      identity("invocations"),
      { message: "hello" },
      async (observer) => {
        for (const event of modelEvents({ costAvailable: true, costUsd: 0 })) {
          observer.onEvent(event);
        }
        return { text: "Hello world" };
      },
    );

    const priced = finishedSpans().filter((span) =>
      ["AGENT", "CHAT_MODEL"].includes(
        String(span.attributes["mlflow.spanType"]),
      ),
    );
    expect(traced.usage).toMatchObject({ costAvailable: true, costUsd: 0 });
    expect(priced).toHaveLength(2);
    for (const span of priced) {
      expect(span.attributes["appkit.cost.available"]).toBe(true);
      expect(span.attributes["mlflow.llm.cost"]).toBe(0);
    }
  });
});
