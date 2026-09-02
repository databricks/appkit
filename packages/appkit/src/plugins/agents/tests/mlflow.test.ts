import { SpanKind } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GatedMlflowSpanProcessor } from "../mlflow";

/**
 * The tracing module keeps module-level singleton state (`enabled`,
 * `initStarted`) and lazily `import()`s `@mlflow/core` (plus two deep-import
 * paths for the exporter/processor classes). Each test resets the module
 * registry and re-mocks the SDK so init runs fresh.
 */

function stubSdk(
  overrides: Record<string, unknown> = {},
  ucFromTags: Record<string, string> | null = null,
) {
  const setInputs = vi.fn();
  const setOutputs = vi.fn();
  const span = { setInputs, setOutputs };
  const sdk = {
    init: vi.fn(),
    // createAuthProvider, MlflowClient, InMemoryTraceManager and
    // SpanAttributeKey are public on @mlflow/core's entrypoint (they were deep
    // imports under mlflow-tracing 0.1.3), so they live on the main mock.
    createAuthProvider: vi.fn(() => ({})),
    MlflowClient: class {
      // Auto-detect probes this; default: experiment exists, UC-ness is then
      // decided by the ucLocationFromExperimentTags mock below.
      getExperiment = vi.fn(async () => ({
        experimentId: "e",
        name: "n",
        tags: {},
      }));
    },
    InMemoryTraceManager: { getInstance: () => ({ popTrace: vi.fn() }) },
    SpanAttributeKey: { SPAN_TYPE: "mlflow.spanType" },
    SpanType: { AGENT: "AGENT", TOOL: "TOOL" },
    withSpan: vi.fn(async (fn: (s: unknown) => unknown) => fn(span)),
    getCurrentActiveSpan: vi.fn(() => ({ traceId: "tr-active" })),
    // Must NOT be consulted by currentTraceId — it only reflects the last
    // root span that *ended*, i.e. a previous/other turn.
    getLastActiveTraceId: vi.fn(() => "tr-STALE"),
    updateCurrentTrace: vi.fn(),
    ...overrides,
  };
  vi.doMock("@mlflow/core", () => sdk);
  // Deep imports used by buildMlflowSpanProcessor — the exporter/processor
  // classes are the only symbols not on @mlflow/core's public entrypoint. Kept
  // as light stubs so setup() wires a processor without touching Databricks.
  class StubProcessor {
    onStart() {}
    onEnd() {}
    forceFlush() {
      return Promise.resolve();
    }
    shutdown() {
      return Promise.resolve();
    }
  }
  vi.doMock("@mlflow/core/dist/exporters/mlflow", () => ({
    MlflowSpanExporter: class {},
    MlflowSpanProcessor: StubProcessor,
  }));
  // Distinct from the classic stub so a test can tell which processor was built
  // and assert the resolved UC location actually reaches its constructor.
  const uc: { built: boolean; location?: unknown } = { built: false };
  vi.doMock("@mlflow/core/dist/exporters/uc_table", () => ({
    DatabricksUCTableSpanExporter: class {},
    DatabricksUCTableSpanProcessor: class {
      constructor(_exporter: unknown, location: unknown) {
        uc.built = true;
        uc.location = location;
      }
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
  // mlflow's experiment-tag → UC-location parser (deep import), used by the
  // numeric-id auto-detect path. Default: not a UC experiment (null → classic).
  vi.doMock("@mlflow/core/dist/core/destination", () => ({
    ucLocationFromExperimentTags: vi.fn(() => ucFromTags),
  }));
  return { sdk, span, setInputs, setOutputs, uc };
}

describe("agent tracing (mlflow)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MLFLOW_EXPERIMENT_ID;
    delete process.env.MLFLOW_UC_CATALOG;
    delete process.env.MLFLOW_UC_SCHEMA;
    delete process.env.MLFLOW_UC_TABLE_PREFIX;
  });

  afterEach(() => {
    vi.doUnmock("@mlflow/core");
    vi.doUnmock("@mlflow/core/dist/exporters/mlflow");
    vi.doUnmock("@mlflow/core/dist/exporters/uc_table");
    vi.doUnmock("@mlflow/core/dist/core/destination");
    vi.doUnmock("../../../telemetry");
    vi.restoreAllMocks();
    delete process.env.MLFLOW_EXPERIMENT_ID;
    delete process.env.MLFLOW_UC_CATALOG;
    delete process.env.MLFLOW_UC_SCHEMA;
    delete process.env.MLFLOW_UC_TABLE_PREFIX;
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

  test("classic: init() is deferred until first trace, not called during setup", async () => {
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

  test("classic: startAgentTracing seeds config eagerly, before any trace", async () => {
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

  test("UC via env vars: builds the UC processor with that location, never calls init()", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    process.env.MLFLOW_UC_CATALOG = "main";
    process.env.MLFLOW_UC_SCHEMA = "mario";
    process.env.MLFLOW_UC_TABLE_PREFIX = "exp-123";
    const { sdk, uc } = stubSdk();
    vi.doMock("../../../telemetry", () => ({
      TelemetryManager: { registerSpanProcessor: vi.fn() },
    }));
    const mod = await import("../mlflow");

    await mod.initAgentTracing();
    mod.startAgentTracing();

    // The env location reaches the UC processor verbatim...
    expect(uc.built).toBe(true);
    expect(uc.location).toEqual({
      catalogName: "main",
      schemaName: "mario",
      tablePrefix: "exp-123",
    });
    // ...and the UC processor reads no global config, so init() — which would
    // stand up @mlflow/core's competing NodeSDK — is never called, not even
    // eagerly on "setup:complete".
    expect(sdk.init).not.toHaveBeenCalled();
    vi.doUnmock("../../../telemetry");
  });

  test("UC via experiment tag: auto-detects the location, builds the UC processor, no init()", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123"; // numeric → auto-detect runs
    const location = {
      catalogName: "main",
      schemaName: "mario",
      tablePrefix: "123",
    };
    const { sdk, uc } = stubSdk({}, location);
    vi.doMock("../../../telemetry", () => ({
      TelemetryManager: { registerSpanProcessor: vi.fn() },
    }));
    const mod = await import("../mlflow");

    await mod.initAgentTracing();
    mod.startAgentTracing();

    expect(uc.built).toBe(true);
    expect(uc.location).toEqual(location);
    expect(sdk.init).not.toHaveBeenCalled(); // UC path skips init()
    vi.doUnmock("../../../telemetry");
  });

  test("numeric experiment with no UC tag: falls back to classic (init seeds config)", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    const { sdk, uc } = stubSdk(); // ucFromTags defaults to null → classic
    vi.doMock("../../../telemetry", () => ({
      TelemetryManager: { registerSpanProcessor: vi.fn() },
    }));
    const mod = await import("../mlflow");

    await mod.initAgentTracing();
    mod.startAgentTracing();

    expect(uc.built).toBe(false); // classic processor, not UC
    expect(sdk.init).toHaveBeenCalledOnce(); // classic needs the config seed
    vi.doUnmock("../../../telemetry");
  });

  test("getExperiment failure during auto-detect: classic fallback, tracing stays enabled", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    const { sdk, uc } = stubSdk({
      MlflowClient: class {
        getExperiment = vi.fn(async () => {
          throw new Error("permission denied");
        });
      },
    });
    vi.doMock("../../../telemetry", () => ({
      TelemetryManager: { registerSpanProcessor: vi.fn() },
    }));
    const mod = await import("../mlflow");

    await mod.initAgentTracing();
    mod.startAgentTracing();

    // A UC-detect failure must never break the agent: classic fallback, enabled.
    expect(uc.built).toBe(false);
    expect(sdk.init).toHaveBeenCalledOnce();
    await mod.traceAgent("agent", { messages: [] }, async () => {});
    expect(sdk.withSpan).toHaveBeenCalled(); // still traces (classic)
    vi.doUnmock("../../../telemetry");
  });

  test("non-numeric experiment id: skips getExperiment (numeric-only) and uses classic", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123"; // non-numeric
    const getExperiment = vi.fn(async () => ({
      experimentId: "x",
      name: "n",
      tags: {},
    }));
    // ucFromTags would return a UC location if the parser were reached...
    const { sdk } = stubSdk(
      {
        MlflowClient: class {
          getExperiment = getExperiment;
        },
      },
      { catalogName: "main", schemaName: "mario", tablePrefix: "x" },
    );
    vi.doMock("../../../telemetry", () => ({
      TelemetryManager: { registerSpanProcessor: vi.fn() },
    }));
    const mod = await import("../mlflow");

    await mod.initAgentTracing();
    mod.startAgentTracing();

    // ...but the numeric gate skips the lookup entirely, so it stays classic.
    expect(getExperiment).not.toHaveBeenCalled();
    expect(sdk.init).toHaveBeenCalledOnce();
    vi.doUnmock("../../../telemetry");
  });

  test("processor build failure: never runs mlflow.init (no ungated global provider)", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "exp-123";
    // buildMlflowSpanProcessor throws (bad creds, or a renamed internal): the
    // gate never registers, but `mlflow` and `initConfig` are already set. If
    // ensureConfigured still called init(), mlflow would stand up its own
    // ungated provider and (with no AppKit provider) win the global slot.
    const { sdk } = stubSdk({
      createAuthProvider: () => {
        throw new Error("bad creds");
      },
    });
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

  // Tripwire: fails loudly if a @mlflow/core version bump moves or renames the
  // deep-imported exporter/processor classes buildMlflowSpanProcessor relies on,
  // or moves the public symbols we now import from the entrypoint. Runs against
  // the REAL package (no mocks); an OSS trackingUri needs no Databricks creds.
  test("@mlflow/core exposes the public + deep-imported symbols we construct", async () => {
    const mlflow = await import("@mlflow/core");
    const {
      createAuthProvider,
      MlflowClient,
      InMemoryTraceManager,
      SpanAttributeKey,
      SpanType,
    } = mlflow;
    const { MlflowSpanExporter, MlflowSpanProcessor } =
      await import("@mlflow/core/dist/exporters/mlflow");
    const { DatabricksUCTableSpanExporter, DatabricksUCTableSpanProcessor } =
      await import("@mlflow/core/dist/exporters/uc_table");
    const { ucLocationFromExperimentTags } =
      await import("@mlflow/core/dist/core/destination");

    // Public entrypoint symbols (deep imports under mlflow-tracing 0.1.3).
    expect(typeof createAuthProvider).toBe("function");
    expect(typeof MlflowClient).toBe("function");
    expect(typeof InMemoryTraceManager.getInstance().popTrace).toBe("function");
    expect(SpanAttributeKey.SPAN_TYPE).toBe("mlflow.spanType");
    expect(SpanType.AGENT).toBe("AGENT");
    expect(SpanType.TOOL).toBe("TOOL");

    // The tracing entrypoints trace()/currentTraceId()/linkTraceToRun() call.
    for (const fn of [
      "init",
      "withSpan",
      "getCurrentActiveSpan",
      "updateCurrentTrace",
    ]) {
      expect(typeof (mlflow as any)[fn]).toBe("function");
    }

    const authProvider = createAuthProvider({
      trackingUri: "http://localhost:5000",
    });
    const client = new MlflowClient({
      trackingUri: "http://localhost:5000",
      authProvider,
    });

    // Classic experiment-backed processor.
    const classic = new MlflowSpanProcessor(new MlflowSpanExporter(client));
    // UC processor takes the exporter plus a UnityCatalogLocation.
    const uc = new DatabricksUCTableSpanProcessor(
      new DatabricksUCTableSpanExporter(client),
      { catalogName: "c", schemaName: "s", tablePrefix: "p" },
    );
    for (const processor of [classic, uc]) {
      for (const method of ["onStart", "onEnd", "forceFlush", "shutdown"]) {
        expect(typeof (processor as any)[method]).toBe("function");
      }
    }

    // getExperiment + the tag parser back UC trace-location auto-detect.
    expect(typeof client.getExperiment).toBe("function");
    expect(
      ucLocationFromExperimentTags({
        "mlflow.experiment.databricksTraceDestinationPath": "cat.schema.prefix",
      }),
    ).toMatchObject({
      catalogName: "cat",
      schemaName: "schema",
      tablePrefix: "prefix",
    });
    expect(ucLocationFromExperimentTags({})).toBeNull();
  });
});

describe("GatedMlflowSpanProcessor", () => {
  const SPAN_TYPE_KEY = "mlflow.spanType";
  // The JSON-stringified AGENT/TOOL values that mark a trace as an agent turn,
  // exactly as buildMlflowSpanProcessor computes them. mlflow stamps UNKNOWN on
  // every non-agent span, so this set must NOT match `'"UNKNOWN"'`.
  const AGENT_SPAN_TYPES = new Set(['"AGENT"', '"TOOL"']);

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
      agentSpanTypes: AGENT_SPAN_TYPES,
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
      // mlflow stamps the SERVER root UNKNOWN; the AGENT child is what counts.
      attributes: { [SPAN_TYPE_KEY]: '"UNKNOWN"' },
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

  // Regression: mlflow's real processor stamps `mlflow.spanType = "UNKNOWN"` on
  // EVERY span it processes, so a presence check (`!== undefined`) would export
  // every plain request. The gate must key on the AGENT/TOOL value instead.
  test("discards a plain request even though mlflow stamps every span UNKNOWN", () => {
    const { inner, popTrace, gated } = mkGated();
    gated.ready();

    const requestRoot = mkSpan({
      kind: SpanKind.SERVER,
      parentSpanContext: undefined,
      attributes: { [SPAN_TYPE_KEY]: '"UNKNOWN"' }, // mlflow stamps the root
      traceId: "tr-plain",
    }); // e.g. /api/analytics/query
    const dbChild = mkSpan({
      kind: SpanKind.CLIENT,
      attributes: { [SPAN_TYPE_KEY]: '"UNKNOWN"' }, // ...and the child
      traceId: "tr-plain",
    }); // SQL warehouse call

    gated.onStart(requestRoot as any, {} as any);
    gated.onStart(dbChild as any, {} as any);
    gated.onEnd(dbChild as any);
    gated.onEnd(requestRoot as any);

    // UNKNOWN is not AGENT/TOOL → discarded from mlflow, not exported.
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

  test("bounds a stuck flush: resolves without hanging when the inner flush never settles", async () => {
    const inner = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      // Never resolves — simulates a wedged UC export.
      forceFlush: vi.fn(() => new Promise<void>(() => {})),
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    };
    const gated = new GatedMlflowSpanProcessor(inner as any, {
      popTrace: vi.fn(),
      spanTypeKey: SPAN_TYPE_KEY,
      agentSpanTypes: AGENT_SPAN_TYPES,
      flushTimeoutMs: 5,
    });

    // Both resolve via the timeout rather than hanging on the inner promise.
    await expect(gated.forceFlush()).resolves.toBeUndefined();
    await expect(gated.shutdown()).resolves.toBeUndefined();
  });
});
