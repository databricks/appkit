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
  vi.doMock("mlflow-tracing/dist/core/trace_manager", () => ({
    InMemoryTraceManager: { getInstance: () => ({ popTrace: vi.fn() }) },
  }));
  vi.doMock("mlflow-tracing/dist/core/constants", () => ({
    SpanAttributeKey: { SPAN_TYPE: "mlflow.spanType" },
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
    vi.doUnmock("mlflow-tracing/dist/core/trace_manager");
    vi.doUnmock("mlflow-tracing/dist/core/constants");
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

  test("processor build failure: never runs mlflow.init (no ungated global provider)", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    const { sdk } = stubSdk();
    // buildMlflowSpanProcessor throws (bad creds, or a renamed internal): the
    // gate never registers, but `mlflow` and `initConfig` are already set. If
    // ensureConfigured still called init(), mlflow would stand up its own
    // ungated provider and (with no AppKit provider) win the global slot.
    vi.doMock("mlflow-tracing/dist/auth", () => ({
      createAuthProvider: () => {
        throw new Error("bad creds");
      },
    }));
    vi.doMock("../../../telemetry", () => ({
      TelemetryManager: { registerSpanProcessor: vi.fn() },
    }));
    const mod = await import("../mlflow");

    await mod.initAgentTracing(); // build throws, swallowed
    mod.startAgentTracing(); // "setup:complete" → ensureConfigured

    expect(sdk.init).not.toHaveBeenCalled();
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

    // The gate also deep-imports popTrace (to discard non-agent traces) and the
    // span-type attribute key (to recognize an mlflow span at onEnd).
    const { InMemoryTraceManager } =
      await import("mlflow-tracing/dist/core/trace_manager");
    const { SpanAttributeKey } =
      await import("mlflow-tracing/dist/core/constants");
    expect(typeof InMemoryTraceManager.getInstance().popTrace).toBe("function");
    expect(SpanAttributeKey.SPAN_TYPE).toBe("mlflow.spanType");
  });
});

describe("GatedMlflowSpanProcessor", () => {
  const SPAN_TYPE_KEY = "mlflow.spanType";

  function mkGated(maxTracked?: number) {
    const inner = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: vi.fn(() => Promise.resolve()),
      shutdown: vi.fn(() => Promise.resolve()),
    };
    const popTrace = vi.fn();
    const gated = new GatedMlflowSpanProcessor(inner as any, {
      popTrace,
      spanTypeKey: SPAN_TYPE_KEY,
      maxTracked,
    });
    return { inner, popTrace, gated };
  }

  // Defaults to an in-turn child span (INTERNAL, has a parent). Override
  // kind/parentSpanContext/attributes/traceId for other cases.
  const mkSpan = (over: Record<string, unknown> = {}) => ({
    name: "s",
    kind: SpanKind.INTERNAL,
    parentSpanContext: { spanId: "parent" },
    attributes: {} as Record<string, unknown>,
    spanContext: () => ({ traceId: (over.traceId as string) ?? "tr-1" }),
    ...over,
  });

  test("stays inert before ready(): no forwarding, so onStart can't throw on early spans", () => {
    const { inner, gated } = mkGated();
    const span = mkSpan();

    gated.onStart(span as any, {} as any);
    gated.onEnd(span as any);

    expect(inner.onStart).not.toHaveBeenCalled();
    expect(inner.onEnd).not.toHaveBeenCalled();
  });

  test("exports the trace when it contains an mlflow (agent) span", () => {
    const { inner, popTrace, gated } = mkGated();
    gated.ready();

    const requestRoot = mkSpan({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
      traceId: "tr-agent",
    }); // incoming request — mlflow roots the trace here
    const agentChild = mkSpan({
      attributes: { [SPAN_TYPE_KEY]: '"AGENT"' },
      traceId: "tr-agent",
    });

    // Real nesting order: root starts, child starts, child ends, root ends last.
    gated.onStart(requestRoot as any, {} as any);
    gated.onStart(agentChild as any, {} as any);
    gated.onEnd(agentChild as any);
    gated.onEnd(requestRoot as any);

    expect(inner.onStart).toHaveBeenCalledTimes(2);
    expect(inner.onEnd).toHaveBeenCalledWith(requestRoot); // exported
    expect(popTrace).not.toHaveBeenCalled();
  });

  test("discards the trace when no agent span appears — a plain HTTP request never becomes an MLflow trace", () => {
    const { inner, popTrace, gated } = mkGated();
    gated.ready();

    const requestRoot = mkSpan({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
      traceId: "tr-plain",
    }); // e.g. /api/analytics/query
    const dbChild = mkSpan({ kind: SpanKind.CLIENT, traceId: "tr-plain" }); // SQL warehouse call — no mlflow.spanType

    gated.onStart(requestRoot as any, {} as any);
    gated.onStart(dbChild as any, {} as any);
    gated.onEnd(dbChild as any);
    gated.onEnd(requestRoot as any);

    // Root discarded from mlflow, not exported.
    expect(popTrace).toHaveBeenCalledExactlyOnceWith("tr-plain");
    expect(inner.onEnd).not.toHaveBeenCalledWith(requestRoot);
  });

  test("scopes per-trace under interleaved concurrent traffic (not a single flag)", () => {
    const { inner, popTrace, gated } = mkGated();
    gated.ready();

    const agentRoot = mkSpan({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
      traceId: "tr-A",
    });
    const agentChild = mkSpan({
      attributes: { [SPAN_TYPE_KEY]: '"AGENT"' },
      traceId: "tr-A",
    });
    const plainRoot = mkSpan({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
      traceId: "tr-B",
    });
    const dbChild = mkSpan({ kind: SpanKind.CLIENT, traceId: "tr-B" });

    // Both traces in flight; the plain one (tr-B) finishes first, the agent one last.
    gated.onStart(agentRoot as any, {} as any);
    gated.onStart(plainRoot as any, {} as any);
    gated.onStart(agentChild as any, {} as any);
    gated.onStart(dbChild as any, {} as any);
    gated.onEnd(dbChild as any);
    gated.onEnd(plainRoot as any);
    gated.onEnd(agentChild as any);
    gated.onEnd(agentRoot as any);

    // A single boolean 'sawAgentSpan' flag would cross-contaminate these.
    expect(popTrace).toHaveBeenCalledExactlyOnceWith("tr-B");
    expect(inner.onEnd).toHaveBeenCalledWith(agentRoot);
    expect(inner.onEnd).not.toHaveBeenCalledWith(plainRoot);
  });

  test("root ending before its agent child (streaming disconnect): discards that turn, stays balanced", () => {
    const { inner, popTrace, gated } = mkGated();
    gated.ready();
    const root = mkSpan({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
      traceId: "tr-race",
    });
    const agentChild = mkSpan({
      attributes: { [SPAN_TYPE_KEY]: '"AGENT"' },
      traceId: "tr-race",
    });

    gated.onStart(root as any, {} as any);
    gated.onStart(agentChild as any, {} as any);
    // HTTP root ends before the agent span's finally runs; the late child must
    // not throw. Documented tradeoff: the aborted turn's trace is discarded.
    gated.onEnd(root as any);
    gated.onEnd(agentChild as any);

    expect(popTrace).toHaveBeenCalledExactlyOnceWith("tr-race");
    expect(inner.onEnd).not.toHaveBeenCalledWith(root);
  });

  test("bounds #agentTraceIds so an abandoned-trace pattern can't leak unboundedly", () => {
    const { popTrace, gated } = mkGated(2); // cap = 2
    gated.ready();

    // Three agent children whose roots never end — orphans their trace ids.
    for (const id of ["tr-1", "tr-2", "tr-3"]) {
      const child = mkSpan({
        attributes: { [SPAN_TYPE_KEY]: '"AGENT"' },
        traceId: id,
      });
      gated.onStart(child as any, {} as any);
      gated.onEnd(child as any);
    }

    // tr-1 was FIFO-evicted at the cap, so if its root ever does arrive it's
    // treated as non-agent (mis-discarded) rather than leaking forever.
    const root1 = mkSpan({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
      traceId: "tr-1",
    });
    gated.onStart(root1 as any, {} as any);
    gated.onEnd(root1 as any);

    expect(popTrace).toHaveBeenCalledWith("tr-1");
  });

  test("agent span that is itself the root (no HTTP wrapper, e.g. eval/CLI) is exported", () => {
    const { inner, popTrace, gated } = mkGated();
    gated.ready();
    // No SERVER wrapper: the AGENT span is the parentless root and marks itself,
    // so the same onEnd both adds the traceId and hits the root branch.
    const agentRoot = mkSpan({
      kind: SpanKind.INTERNAL,
      parentSpanContext: undefined,
      attributes: { [SPAN_TYPE_KEY]: '"AGENT"' },
      traceId: "tr-eval",
    });

    gated.onStart(agentRoot as any, {} as any);
    gated.onEnd(agentRoot as any);

    expect(inner.onEnd).toHaveBeenCalledWith(agentRoot); // exported
    expect(popTrace).not.toHaveBeenCalled();
  });

  test("drops the exporters' own outbound spans (parentless CLIENT) — breaks the loop", () => {
    const { inner, popTrace, gated } = mkGated();
    gated.ready();
    // An mlflow/OTLP upload: outgoing HTTP with no parent (made outside any turn).
    const uploadSpan = mkSpan({
      kind: SpanKind.CLIENT,
      parentSpanContext: undefined,
      traceId: "tr-upload",
    });

    gated.onStart(uploadSpan as any, {} as any);
    gated.onEnd(uploadSpan as any);

    expect(inner.onStart).not.toHaveBeenCalled();
    expect(inner.onEnd).not.toHaveBeenCalled();
    expect(popTrace).not.toHaveBeenCalled(); // never registered, nothing to discard
  });

  test("onEnd is skipped for spans whose onStart was not forwarded (balanced)", () => {
    const { inner, popTrace, gated } = mkGated();
    const early = mkSpan();

    gated.onStart(early as any, {} as any); // dropped (not ready)
    gated.ready();
    gated.onEnd(early as any); // must NOT forward — inner never saw its start

    expect(inner.onEnd).not.toHaveBeenCalled();
    expect(popTrace).not.toHaveBeenCalled();
  });

  test("delegates forceFlush and shutdown to the inner processor", async () => {
    const { inner, gated } = mkGated();

    await gated.forceFlush();
    await gated.shutdown();

    expect(inner.forceFlush).toHaveBeenCalledOnce();
    expect(inner.shutdown).toHaveBeenCalledOnce();
  });
});
