import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The tracing module keeps module-level singleton state (`enabled`,
 * `initStarted`) and lazily `import()`s `mlflow-tracing`. Each test resets the
 * module registry and re-mocks the SDK so init runs fresh.
 */

function stubSdk(overrides: Record<string, unknown> = {}) {
  const setInputs = vi.fn();
  const setOutputs = vi.fn();
  const span = { setInputs, setOutputs };
  const sdk = {
    init: vi.fn(),
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
  return { sdk, span, setInputs, setOutputs };
}

describe("agent tracing (mlflow)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MLFLOW_EXPERIMENT_ID;
  });

  afterEach(() => {
    vi.doUnmock("mlflow-tracing");
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
});
