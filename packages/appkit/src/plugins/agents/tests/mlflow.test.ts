import { SpanKind } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GatedMlflowSpanProcessor } from "../mlflow";

/**
 * The tracing module keeps module-level singleton state (`enabled`,
 * `initStarted`) and lazily `import()`s `mlflow-tracing` (plus two deep-import
 * paths for the span processor). Each test resets the module registry and
 * re-mocks the SDK so init runs fresh.
 */

function stubSdk(overrides: Record<string, unknown> = {}) {
  const setInputs = vi.fn();
  const setOutputs = vi.fn();
  const span = { setInputs, setOutputs };
  const sdk = {
    init: vi.fn(),
    MlflowClient: class {},
    SpanType: { AGENT: "AGENT", TOOL: "TOOL" },
    withSpan: vi.fn(async (fn: (s: unknown) => unknown) => fn(span)),
    getCurrentActiveSpan: vi.fn(() => ({ traceId: "tr-active" })),
    // Must NOT be consulted by currentTraceId — it only reflects the last
    // root span that *ended*, i.e. a previous/other turn.
    getLastActiveTraceId: vi.fn(() => "tr-STALE"),
    updateCurrentTrace: vi.fn(),
    ...overrides,
  };
  vi.doMock("mlflow-tracing", () => sdk);
  // Deep imports used by buildMlflowSpanProcessor — kept as light stubs so
  // setup() wires a processor without touching real Databricks auth.
  vi.doMock("mlflow-tracing/dist/auth", () => ({
    createAuthProvider: vi.fn(() => ({})),
  }));
  vi.doMock("mlflow-tracing/dist/exporters/mlflow", () => ({
    MlflowSpanExporter: class {},
    MlflowSpanProcessor: class {
      onStart() {}
      onEnd() {}
      forceFlush() {
        return Promise.resolve();
      }
      shutdown() {
        return Promise.resolve();
      }
    },
  }));
  return { sdk, span, setInputs, setOutputs };
}

describe("agent tracing (mlflow)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MLFLOW_EXPERIMENT_ID;
  });

  afterEach(() => {
    vi.doUnmock("mlflow-tracing");
    vi.doUnmock("mlflow-tracing/dist/auth");
    vi.doUnmock("mlflow-tracing/dist/exporters/mlflow");
    vi.doUnmock("../../../telemetry");
    vi.restoreAllMocks();
    delete process.env.MLFLOW_EXPERIMENT_ID;
  });

  test("disabled (no experiment bound): still runs fn and returns its value", async () => {
    const mod = await import("../mlflow");
    await mod.initAgentTracing();

    const fn = vi.fn(async () => "result");
    await expect(mod.traceTool("t", { a: 1 }, fn)).resolves.toBe("result");
    expect(fn).toHaveBeenCalledOnce();
    expect(mod.currentTraceId()).toBeUndefined();
  });

  test("no experiment bound: contributes no span processor", async () => {
    const { TelemetryManager } = await import("../../../telemetry");
    const spy = vi
      .spyOn(TelemetryManager, "registerSpanProcessor")
      .mockImplementation(() => {});

    const mod = await import("../mlflow");
    await mod.initAgentTracing();

    expect(spy).not.toHaveBeenCalled();
  });

  test("experiment bound: contributes a span processor during setup", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    stubSdk();
    const { TelemetryManager } = await import("../../../telemetry");
    const spy = vi
      .spyOn(TelemetryManager, "registerSpanProcessor")
      .mockImplementation(() => {});

    const mod = await import("../mlflow");
    await mod.initAgentTracing();

    expect(spy).toHaveBeenCalledOnce();
  });

  test("init() is deferred until first trace, not called during setup", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    const { sdk } = stubSdk();
    vi.doMock("../../../telemetry", () => ({
      TelemetryManager: { registerSpanProcessor: vi.fn() },
    }));
    const mod = await import("../mlflow");

    await mod.initAgentTracing();
    expect(sdk.init).not.toHaveBeenCalled(); // deferred

    await mod.traceAgent("agent", { messages: [] }, async () => {});
    expect(sdk.init).toHaveBeenCalledOnce(); // seeded lazily on first trace
    vi.doUnmock("../../../telemetry");
  });

  test("startAgentTracing seeds config eagerly, before any trace", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    const { sdk } = stubSdk();
    vi.doMock("../../../telemetry", () => ({
      TelemetryManager: { registerSpanProcessor: vi.fn() },
    }));
    const mod = await import("../mlflow");

    await mod.initAgentTracing();
    expect(sdk.init).not.toHaveBeenCalled(); // not during setup

    // Fired from the "setup:complete" lifecycle hook, after start(), before any
    // request — so the first turn's root span is already forwarded.
    mod.startAgentTracing();
    expect(sdk.init).toHaveBeenCalledOnce();
    vi.doUnmock("../../../telemetry");
  });

  test("currentTraceId reads the context-active span, not getLastActiveTraceId", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    const { sdk } = stubSdk();
    const mod = await import("../mlflow");
    await mod.initAgentTracing();

    let seen: string | undefined;
    await mod.traceAgent("agent", { messages: [] }, async () => {
      seen = mod.currentTraceId();
    });

    expect(seen).toBe("tr-active");
    expect(sdk.getCurrentActiveSpan).toHaveBeenCalled();
    expect(sdk.getLastActiveTraceId).not.toHaveBeenCalled();
  });

  test("auto-captures the callback's return value as span outputs", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    const { setOutputs } = stubSdk();
    const mod = await import("../mlflow");
    await mod.initAgentTracing();

    await mod.traceTool("t", { a: 1 }, async () => ({ ok: true }));
    expect(setOutputs).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });

  test("explicit setOutputs wins over auto-capture (no double-set)", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    const { setOutputs } = stubSdk();
    const mod = await import("../mlflow");
    await mod.initAgentTracing();

    await mod.traceAgent("agent", { messages: [] }, async (span) => {
      span.setOutputs({ role: "assistant", content: "hi" });
      return "ignored-return";
    });
    expect(setOutputs).toHaveBeenCalledExactlyOnceWith({
      role: "assistant",
      content: "hi",
    });
  });

  // Tripwire: fails loudly if a mlflow-tracing version bump moves or renames the
  // deep-imported internals buildMlflowSpanProcessor() relies on. Runs against
  // the REAL package (no mocks); an OSS trackingUri needs no Databricks creds.
  test("mlflow-tracing exposes the deep-imported symbols we construct", async () => {
    const { createAuthProvider } = await import("mlflow-tracing/dist/auth");
    const { MlflowSpanExporter, MlflowSpanProcessor } =
      await import("mlflow-tracing/dist/exporters/mlflow");
    const { MlflowClient } = await import("mlflow-tracing");

    expect(typeof createAuthProvider).toBe("function");
    expect(typeof MlflowClient).toBe("function");
    expect(typeof MlflowSpanExporter).toBe("function");
    expect(typeof MlflowSpanProcessor).toBe("function");

    const authProvider = createAuthProvider({
      trackingUri: "http://localhost:5000",
    });
    const client = new MlflowClient({
      trackingUri: "http://localhost:5000",
      authProvider,
    });
    const processor = new MlflowSpanProcessor(new MlflowSpanExporter(client));
    for (const method of ["onStart", "onEnd", "forceFlush", "shutdown"]) {
      expect(typeof (processor as any)[method]).toBe("function");
    }
  });
});

describe("GatedMlflowSpanProcessor", () => {
  function fakeInner() {
    return {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: vi.fn(() => Promise.resolve()),
      shutdown: vi.fn(() => Promise.resolve()),
    };
  }

  // Defaults to an in-turn child span (INTERNAL, has a parent) — the case we
  // want forwarded. Override kind/parent for the edge cases.
  const mkSpan = (over: Record<string, unknown> = {}) => ({
    name: "s",
    kind: SpanKind.INTERNAL,
    parentSpanContext: { spanId: "parent" },
    ...over,
  });

  test("stays inert before ready(): no forwarding, so onStart can't throw on early spans", () => {
    const inner = fakeInner();
    const gated = new GatedMlflowSpanProcessor(inner as any);
    const span = mkSpan();

    gated.onStart(span as any, {} as any);
    gated.onEnd(span as any);

    expect(inner.onStart).not.toHaveBeenCalled();
    expect(inner.onEnd).not.toHaveBeenCalled();
  });

  test("once ready(), forwards in-turn spans and the incoming request root", () => {
    const inner = fakeInner();
    const gated = new GatedMlflowSpanProcessor(inner as any);
    gated.ready();

    const child = mkSpan(); // agent/tool span inside the turn
    const requestRoot = mkSpan({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
    }); // incoming /chat span — mlflow roots the trace here
    const outgoingChild = mkSpan({ kind: SpanKind.CLIENT }); // LLM call under the agent

    for (const s of [child, requestRoot, outgoingChild]) {
      gated.onStart(s as any, {} as any);
      gated.onEnd(s as any);
    }

    expect(inner.onStart).toHaveBeenCalledTimes(3);
    expect(inner.onEnd).toHaveBeenCalledTimes(3);
  });

  test("drops the exporters' own outbound spans (parentless CLIENT) — breaks the loop", () => {
    const inner = fakeInner();
    const gated = new GatedMlflowSpanProcessor(inner as any);
    gated.ready();
    // An mlflow/OTLP upload: outgoing HTTP with no parent (made outside any turn).
    const uploadSpan = mkSpan({
      kind: SpanKind.CLIENT,
      parentSpanContext: undefined,
    });

    gated.onStart(uploadSpan as any, {} as any);
    gated.onEnd(uploadSpan as any);

    expect(inner.onStart).not.toHaveBeenCalled();
    expect(inner.onEnd).not.toHaveBeenCalled();
  });

  test("onEnd is skipped for spans whose onStart was not forwarded (balanced)", () => {
    const inner = fakeInner();
    const gated = new GatedMlflowSpanProcessor(inner as any);
    const early = mkSpan();

    gated.onStart(early as any, {} as any); // dropped (not ready)
    gated.ready();
    gated.onEnd(early as any); // must NOT forward — inner never saw its start

    expect(inner.onEnd).not.toHaveBeenCalled();
  });

  test("delegates forceFlush and shutdown to the inner processor", async () => {
    const inner = fakeInner();
    const gated = new GatedMlflowSpanProcessor(inner as any);

    await gated.forceFlush();
    await gated.shutdown();

    expect(inner.forceFlush).toHaveBeenCalledOnce();
    expect(inner.shutdown).toHaveBeenCalledOnce();
  });
});
