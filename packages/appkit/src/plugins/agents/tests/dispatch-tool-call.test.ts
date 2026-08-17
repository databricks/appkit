import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { CacheManager } from "../../../cache";
import { runWithAgentTrace } from "../../../telemetry/agent-tracing";
import { AgentsPlugin } from "../agents";

/**
 * Verifies that `dispatchToolCall` is the single source of truth for the
 * approval gate, the per-run tool-call budget, and result normalization.
 *
 * The agentic review on PR #304 flagged three regressions that all share
 * this code path:
 *
 * 1. The approval gate ignored `effect: "destructive"` (only honoured the
 *    legacy `destructive: true` boolean).
 * 2. Sub-agent `childExecute` bypassed the tool-call budget entirely.
 * 3. Sub-agent `childExecute` bypassed the approval gate.
 *
 * The current shape factors approval / budget / dispatch into one method
 * that both the top-level adapter and `runSubAgent` share via a
 * common `RunState` object. Tests below pin those guarantees.
 */

beforeAll(() => {
  context.disable();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
});

afterAll(() => {
  context.disable();
});

beforeEach(() => {
  // dispatchToolCall is exercised without going through setup(), so we
  // need the cache singleton to be initialised before the plugin reads it.
  // biome-ignore lint/suspicious/noExplicitAny: test seam, mirrors other suites
  (CacheManager as any).instance = {
    get: vi.fn(),
    set: vi.fn(),
    getOrExecute: vi.fn(
      async (_k: unknown[], fn: (signal?: AbortSignal) => Promise<unknown>) =>
        fn(),
    ),
    generateKey: vi.fn(() => "test-key"),
  };
});

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
  return {
    spans,
    ...(error !== undefined ? { error } : {}),
  };
}

function semanticSpan(spans: ReadableSpan[], spanType: string): ReadableSpan {
  const span = spans.find(
    (candidate) => candidate.attributes["mlflow.spanType"] === spanType,
  );
  expect(span, `missing ${spanType} span`).toBeDefined();
  return span as ReadableSpan;
}

function mockReq(): express.Request {
  return {
    body: {},
    headers: {},
    header: () => undefined,
  } as unknown as express.Request;
}

function makeRunState(plugin: AgentsPlugin) {
  const abortController = new AbortController();
  const pushed: unknown[] = [];
  const runState = {
    req: mockReq(),
    userId: "alice",
    requestId: "stream-1",
    abortController,
    signal: abortController.signal,
    approvalPolicy: { requireForDestructive: true, timeoutMs: 60_000 },
    limits: {
      maxConcurrentStreamsPerUser: 5,
      maxToolCalls: 50,
      maxSubAgentDepth: 3,
      toolCallTimeoutMs: 300_000,
    },
    translator: {
      translate: (event: unknown) => [event],
    },
    outboundEvents: {
      push: (event: unknown) => pushed.push(event),
    },
    traceIdentity: {
      appName: "test-app",
      route: "chat",
      sessionId: "session-1",
      userId: "alice",
      requestId: "stream-1",
    },
    toolCallsUsed: { count: 0 },
  };
  return { runState, pushed, plugin };
}

function callDispatch(
  plugin: AgentsPlugin,
  args: {
    runState: unknown;
    toolIndex: Map<string, unknown>;
    name: string;
    args: unknown;
    depth?: number;
  },
): Promise<unknown> {
  return (
    plugin as unknown as {
      dispatchToolCall: (
        runState: unknown,
        toolIndex: Map<string, unknown>,
        name: string,
        args: unknown,
        depth: number,
      ) => Promise<unknown>;
    }
  ).dispatchToolCall(
    args.runState,
    args.toolIndex,
    args.name,
    args.args,
    args.depth ?? 0,
  );
}

describe("dispatchToolCall — semantic TOOL spans", () => {
  test("creates one TOOL descendant for inline, toolkit, MCP, and local sub-agent dispatch", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);
    // These are the slow/external boundaries for toolkit and MCP execution;
    // dispatch and span creation remain real.
    // biome-ignore lint/suspicious/noExplicitAny: seed private integration seams
    (plugin as any).context = {
      executeTool: vi.fn().mockResolvedValue({ rows: [1, 2] }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: seed private integration seam
    (plugin as any).mcpClient = {
      callTool: vi.fn().mockResolvedValue({ content: "remote" }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: isolate dispatch from adapter streaming
    (plugin as any).runSubAgent = vi.fn().mockResolvedValue({
      text: "child output",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costAvailable: false,
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: seed the child registry lookup
    (plugin as any).agents.set("researcher", { name: "researcher" });

    const toolIndex = new Map<string, unknown>([
      [
        "inline",
        {
          source: "function",
          def: {
            name: "inline",
            description: "inline",
            parameters: { type: "object" },
            annotations: { effect: "read" },
          },
          functionTool: {
            execute: vi.fn().mockResolvedValue({ answer: 42 }),
          },
        },
      ],
      [
        "analytics.query",
        {
          source: "toolkit",
          pluginName: "analytics",
          localName: "query",
          def: {
            name: "analytics.query",
            description: "query",
            parameters: { type: "object" },
            annotations: { effect: "read" },
          },
        },
      ],
      [
        "remote_lookup",
        {
          source: "mcp",
          mcpToolName: "remote_lookup",
          def: {
            name: "remote_lookup",
            description: "remote",
            parameters: { type: "object" },
            annotations: { effect: "read" },
          },
        },
      ],
      [
        "agent-researcher",
        {
          source: "subagent",
          agentName: "researcher",
          def: {
            name: "agent-researcher",
            description: "delegate",
            parameters: { type: "object" },
          },
        },
      ],
    ]);

    const observed = await captureSpans(() =>
      runWithAgentTrace(
        {
          appName: "trace-test",
          agentName: "planner",
          route: "chat",
          sessionId: "session-1",
          userId: "alice",
          requestId: "request-1",
          threadId: "thread-1",
        },
        { message: "run tools" },
        async () => {
          await callDispatch(plugin, {
            runState,
            toolIndex,
            name: "inline",
            args: { password: "do-not-log", question: "meaning" },
          });
          await callDispatch(plugin, {
            runState,
            toolIndex,
            name: "analytics.query",
            args: { sql: "SELECT 1" },
          });
          await callDispatch(plugin, {
            runState,
            toolIndex,
            name: "remote_lookup",
            args: { id: 7 },
          });
          await callDispatch(plugin, {
            runState,
            toolIndex,
            name: "agent-researcher",
            args: { input: "investigate" },
          });
          return "done";
        },
      ),
    );

    expect(observed.error).toBeUndefined();
    const root = semanticSpan(observed.spans, "AGENT");
    const tools = observed.spans.filter(
      (span) => span.attributes["mlflow.spanType"] === "TOOL",
    );
    expect(tools).toHaveLength(4);
    expect(
      tools.map((span) => [
        span.attributes["gen_ai.operation.name"],
        span.attributes["gen_ai.tool.name"],
      ]),
    ).toEqual([
      ["execute_tool", "inline"],
      ["execute_tool", "analytics.query"],
      ["execute_tool", "remote_lookup"],
      ["execute_tool", "agent-researcher"],
    ]);
    expect(
      tools.map((span) => [
        span.attributes["appkit.tool.name"],
        span.attributes["appkit.tool.source"],
        span.attributes["appkit.tool.effect"],
      ]),
    ).toEqual([
      ["inline", "function", "read"],
      ["analytics.query", "toolkit", "read"],
      ["remote_lookup", "mcp", "read"],
      ["agent-researcher", "subagent", undefined],
    ]);
    expect(
      tools.every(
        (span) =>
          span.parentSpanContext?.spanId === root.spanContext().spanId &&
          span.status.code === SpanStatusCode.OK &&
          typeof span.attributes["appkit.tool.duration_ms"] === "number",
      ),
    ).toBe(true);
    expect(
      JSON.parse(String(tools[0].attributes["mlflow.spanInputs"])),
    ).toEqual({ password: "[REDACTED]", question: "meaning" });
    expect(JSON.parse(String(tools[0].attributes["mlflow.spanOutputs"]))).toBe(
      '{"answer":42}',
    );
    expect(JSON.parse(String(tools[1].attributes["mlflow.spanOutputs"]))).toBe(
      '{"rows":[1,2]}',
    );
    expect(JSON.parse(String(tools[2].attributes["mlflow.spanOutputs"]))).toBe(
      '{"content":"remote"}',
    );
    expect(JSON.parse(String(tools[3].attributes["mlflow.spanOutputs"]))).toBe(
      "child output",
    );
  });

  test("traces unknown tools as a failed TOOL without exposing the thrown detail", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);

    const observed = await captureSpans(() =>
      callDispatch(plugin, {
        runState,
        toolIndex: new Map(),
        name: "missing_secret_tool",
        args: { apiKey: "sensitive" },
      }),
    );

    expect(observed.error).toEqual(
      new Error("Unknown tool: missing_secret_tool"),
    );
    const tool = semanticSpan(observed.spans, "TOOL");
    expect(tool.attributes).toMatchObject({
      "appkit.tool.name": "missing_secret_tool",
      "appkit.tool.source": "unknown",
      "appkit.error": '{"error":"[REDACTED]"}',
    });
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.parse(String(tool.attributes["mlflow.spanOutputs"]))).toEqual({
      error: "[REDACTED]",
      partial_output: { available: false, reason: "no output produced" },
    });
    expect(tool.attributes["appkit.tool.duration_ms"]).toEqual(
      expect.any(Number),
    );
    expect(
      JSON.stringify({ attributes: tool.attributes, events: tool.events }),
    ).not.toContain("Unknown tool: missing_secret_tool");
  });

  test("traces malformed function arguments and never invokes the function body", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);
    const execute = vi.fn();
    const toolIndex = new Map<string, unknown>([
      [
        "object_only",
        {
          source: "function",
          def: {
            name: "object_only",
            description: "object",
            parameters: { type: "object" },
          },
          functionTool: { execute },
        },
      ],
    ]);

    const observed = await captureSpans(() =>
      callDispatch(plugin, {
        runState,
        toolIndex,
        name: "object_only",
        args: ["wrong"],
      }),
    );

    expect(observed.error).toEqual(
      new Error(
        "Function tool 'object_only' received non-object arguments (got array); expected a JSON object.",
      ),
    );
    expect(execute).not.toHaveBeenCalled();
    const tool = semanticSpan(observed.spans, "TOOL");
    expect(tool.attributes["appkit.tool.source"]).toBe("function");
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
  });

  test("records a toolkit timeout as a sanitized failed TOOL", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);
    // biome-ignore lint/suspicious/noExplicitAny: isolate the PluginContext boundary
    (plugin as any).context = {
      executeTool: vi
        .fn()
        .mockRejectedValue(
          new DOMException("private timeout detail", "TimeoutError"),
        ),
    };
    const toolIndex = new Map<string, unknown>([
      [
        "analytics.slow",
        {
          source: "toolkit",
          pluginName: "analytics",
          localName: "slow",
          def: {
            name: "analytics.slow",
            description: "slow",
            parameters: { type: "object" },
          },
        },
      ],
    ]);

    const observed = await captureSpans(() =>
      callDispatch(plugin, {
        runState,
        toolIndex,
        name: "analytics.slow",
        args: {},
      }),
    );

    expect(observed.error).toBeInstanceOf(DOMException);
    const tool = semanticSpan(observed.spans, "TOOL");
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.attributes["appkit.error"]).toBe('{"error":"[REDACTED]"}');
    expect(
      JSON.stringify({ attributes: tool.attributes, events: tool.events }),
    ).not.toContain("private timeout detail");
  });

  test("records a function failure as a sanitized failed TOOL", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);
    const toolIndex = new Map<string, unknown>([
      [
        "explode",
        {
          source: "function",
          def: {
            name: "explode",
            description: "fail",
            parameters: { type: "object" },
          },
          functionTool: {
            execute: async () => {
              throw new Error("database password hunter2");
            },
          },
        },
      ],
    ]);

    const observed = await captureSpans(() =>
      callDispatch(plugin, {
        runState,
        toolIndex,
        name: "explode",
        args: {},
      }),
    );

    expect(observed.error).toEqual(new Error("database password hunter2"));
    const tool = semanticSpan(observed.spans, "TOOL");
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.attributes["appkit.error"]).toBe('{"error":"[REDACTED]"}');
    expect(
      JSON.stringify({ attributes: tool.attributes, events: tool.events }),
    ).not.toContain("hunter2");
  });
});

describe("dispatchToolCall — semantic approval descendants", () => {
  function destructiveTool(execute: ReturnType<typeof vi.fn>) {
    return new Map<string, unknown>([
      [
        "delete_user",
        {
          source: "function",
          def: {
            name: "delete_user",
            description: "delete",
            parameters: { type: "object" },
            annotations: { effect: "destructive" },
          },
          functionTool: { execute },
        },
      ],
    ]);
  }

  test("nests an approved CHAIN under TOOL and runs the body only after approve", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState, pushed } = makeRunState(plugin);
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push("tool");
      return "deleted";
    });

    const observed = await captureSpans(async () => {
      const pending = callDispatch(plugin, {
        runState,
        toolIndex: destructiveTool(execute),
        name: "delete_user",
        args: { userId: 7, password: "do-not-log" },
      });
      order.push("waiting");
      expect(execute).not.toHaveBeenCalled();
      const approvalId = (pushed[0] as { approvalId: string }).approvalId;
      order.push("approved");
      // biome-ignore lint/suspicious/noExplicitAny: exercise the real private gate
      (plugin as any).approvalGate.submit({
        approvalId,
        userId: "alice",
        decision: "approve",
      });
      await pending;
    });

    expect(observed.error).toBeUndefined();
    expect(order).toEqual(["waiting", "approved", "tool"]);
    const tool = semanticSpan(observed.spans, "TOOL");
    const approval = semanticSpan(observed.spans, "CHAIN");
    expect(approval.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(approval.attributes).toMatchObject({
      "appkit.approval.decision": "approve",
      "appkit.approval.state": "approved",
      "appkit.tool.name": "delete_user",
      "appkit.approval.duration_ms": expect.any(Number),
    });
    expect(
      JSON.parse(String(approval.attributes["mlflow.spanInputs"])),
    ).toEqual({
      password: "[REDACTED]",
      userId: 7,
    });
    expect(tool.status.code).toBe(SpanStatusCode.OK);
  });

  test("records denial and leaves the tool body idle", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState, pushed } = makeRunState(plugin);
    const execute = vi.fn();
    let result: unknown;

    const observed = await captureSpans(async () => {
      const pending = callDispatch(plugin, {
        runState,
        toolIndex: destructiveTool(execute),
        name: "delete_user",
        args: { userId: 7 },
      });
      const approvalId = (pushed[0] as { approvalId: string }).approvalId;
      // biome-ignore lint/suspicious/noExplicitAny: exercise the real private gate
      (plugin as any).approvalGate.submit({
        approvalId,
        userId: "alice",
        decision: "deny",
      });
      result = await pending;
    });

    expect(observed.error).toBeUndefined();
    expect(result).toBe(
      "Tool execution denied by user approval gate (tool: delete_user).",
    );
    expect(execute).not.toHaveBeenCalled();
    const approval = semanticSpan(observed.spans, "CHAIN");
    expect(approval.attributes).toMatchObject({
      "appkit.approval.decision": "deny",
      "appkit.approval.state": "denied",
    });
  });
});

describe("dispatchToolCall — approval gate honours `effect`", () => {
  test('fires for `effect: "destructive"` even without legacy `destructive: true`', async () => {
    // Regression for finding #1 on PR #304: the gate previously checked
    // only `annotations.destructive === true` and let `effect:"destructive"`
    // through unapproved.
    const plugin = new AgentsPlugin({ dir: false });
    const { runState, pushed } = makeRunState(plugin);

    const execute = vi.fn().mockResolvedValue("ok");
    const toolIndex = new Map<string, unknown>([
      [
        "drop_table",
        {
          source: "function",
          def: {
            name: "drop_table",
            description: "drops",
            parameters: { type: "object" },
            annotations: { effect: "destructive" },
          },
          functionTool: { execute },
        },
      ],
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: stub the gate to simulate user approval
    (plugin as any).approvalGate.wait = vi.fn().mockResolvedValue("approve");

    await callDispatch(plugin, {
      runState,
      toolIndex,
      name: "drop_table",
      args: {},
    });

    // biome-ignore lint/suspicious/noExplicitAny: gate is private but stubbed above
    expect((plugin as any).approvalGate.wait).toHaveBeenCalledTimes(1);
    expect(pushed.length).toBeGreaterThan(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test.each<["read" | undefined, boolean]>([
    ["read", false],
    [undefined, false],
  ])(
    "does NOT fire for non-mutating `effect` value %p",
    async (effect, expectGate) => {
      const plugin = new AgentsPlugin({ dir: false });
      const { runState } = makeRunState(plugin);

      const annotations = effect ? { effect } : undefined;
      const toolIndex = new Map<string, unknown>([
        [
          "select",
          {
            source: "function",
            def: {
              name: "select",
              description: "reads",
              parameters: { type: "object" },
              annotations,
            },
            functionTool: { execute: vi.fn().mockResolvedValue("rows") },
          },
        ],
      ]);

      // biome-ignore lint/suspicious/noExplicitAny: stub gate
      (plugin as any).approvalGate.wait = vi.fn();

      await callDispatch(plugin, {
        runState,
        toolIndex,
        name: "select",
        args: {},
      });

      // biome-ignore lint/suspicious/noExplicitAny: assertions on stub
      expect((plugin as any).approvalGate.wait).toHaveBeenCalledTimes(
        expectGate ? 1 : 0,
      );
    },
  );

  test("denying the gate returns the deny string and does not invoke the tool", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);

    const execute = vi.fn();
    const toolIndex = new Map<string, unknown>([
      [
        "delete_user",
        {
          source: "function",
          def: {
            name: "delete_user",
            description: "del",
            parameters: { type: "object" },
            annotations: { effect: "destructive" },
          },
          functionTool: { execute },
        },
      ],
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: stub deny
    (plugin as any).approvalGate.wait = vi.fn().mockResolvedValue("deny");

    const result = await callDispatch(plugin, {
      runState,
      toolIndex,
      name: "delete_user",
      args: {},
    });

    expect(result).toBe(
      "Tool execution denied by user approval gate (tool: delete_user).",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("dispatchToolCall — shared tool-call budget", () => {
  test("subsequent calls increment the shared counter", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);

    const toolIndex = new Map<string, unknown>([
      [
        "noop",
        {
          source: "function",
          def: {
            name: "noop",
            description: "nothing",
            parameters: { type: "object" },
          },
          functionTool: { execute: vi.fn().mockResolvedValue("ok") },
        },
      ],
    ]);

    await callDispatch(plugin, { runState, toolIndex, name: "noop", args: {} });
    await callDispatch(plugin, { runState, toolIndex, name: "noop", args: {} });
    await callDispatch(plugin, { runState, toolIndex, name: "noop", args: {} });

    expect(runState.toolCallsUsed.count).toBe(3);
  });

  test("rejects + aborts when the budget is exhausted", async () => {
    const plugin = new AgentsPlugin({
      dir: false,
      limits: { maxToolCalls: 2 },
    });
    const { runState } = makeRunState(plugin);
    runState.limits.maxToolCalls = 2;

    const toolIndex = new Map<string, unknown>([
      [
        "noop",
        {
          source: "function",
          def: {
            name: "noop",
            description: "nothing",
            parameters: { type: "object" },
          },
          functionTool: { execute: vi.fn().mockResolvedValue("ok") },
        },
      ],
    ]);

    await callDispatch(plugin, { runState, toolIndex, name: "noop", args: {} });
    await callDispatch(plugin, { runState, toolIndex, name: "noop", args: {} });

    await expect(
      callDispatch(plugin, { runState, toolIndex, name: "noop", args: {} }),
    ).rejects.toThrow(/Tool-call budget exhausted/);
    expect(runState.signal.aborted).toBe(true);
  });
});

describe("dispatchToolCall — toolkit timeout plumbing", () => {
  /**
   * The 30s default in `PluginContext.executeTool` was too short for cold
   * SQL Warehouse round-trips and long Genie conversations — analytics tool
   * calls would die with a stale-looking error. The fix routes
   * `runState.limits.toolCallTimeoutMs` through to `PluginContext` so the
   * agents plugin owns the cap and the default (5 minutes) is generous.
   */
  test("forwards runState.limits.toolCallTimeoutMs to PluginContext.executeTool", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);
    runState.limits.toolCallTimeoutMs = 90_000;

    const executeTool = vi.fn().mockResolvedValue("rows");
    // biome-ignore lint/suspicious/noExplicitAny: stub PluginContext shape
    (plugin as any).context = { executeTool };

    const toolIndex = new Map<string, unknown>([
      [
        "analytics.query",
        {
          source: "toolkit",
          pluginName: "analytics",
          localName: "query",
          def: {
            name: "analytics.query",
            description: "sql",
            parameters: { type: "object" },
          },
        },
      ],
    ]);

    await callDispatch(plugin, {
      runState,
      toolIndex,
      name: "analytics.query",
      args: { sql: "SELECT 1" },
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    const call = executeTool.mock.calls[0];
    // (req, pluginName, toolName, args, signal, timeoutMs)
    expect(call[1]).toBe("analytics");
    expect(call[2]).toBe("query");
    expect(call[5]).toBe(90_000);
  });

  test("resolvedLimits exposes the documented 5-minute default", () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: read private getter
    const limits = (plugin as any).resolvedLimits;
    expect(limits.toolCallTimeoutMs).toBe(300_000);
  });

  test("honours agents({ limits: { toolCallTimeoutMs } })", () => {
    const plugin = new AgentsPlugin({
      dir: false,
      limits: { toolCallTimeoutMs: 600_000 },
    });
    // biome-ignore lint/suspicious/noExplicitAny: read private
    const limits = (plugin as any).resolvedLimits;
    expect(limits.toolCallTimeoutMs).toBe(600_000);
  });
});

describe("runSubAgent — sub-agent event forwarding", () => {
  /**
   * The smart-dashboard `query` agent delegates to `dashboard_pilot`, which
   * emits UI-action `tool_call` events (apply_filter, highlight_period) that
   * the client reads off the parent's SSE stream. Without forwarding those
   * inner events, the user asks for a highlight and nothing visible
   * happens. `metadata` events are NOT forwarded because the sub-agent has
   * its own threadId and overwriting the parent's would break multi-turn.
   */
  test("rejects when depth exceeds limits.maxSubAgentDepth before invoking the child", async () => {
    // Backstop for the runtime cycle case: even without an explicit
    // cycle, two agents delegating to each other will eventually exceed
    // the depth limit and we want a clear error, not an unbounded stack.
    const plugin = new AgentsPlugin({
      dir: false,
      agents: {},
      limits: { maxSubAgentDepth: 2 },
    });
    const { runState } = makeRunState(plugin);
    runState.limits.maxSubAgentDepth = 2;

    const childRun = vi.fn();
    const child = {
      name: "child",
      instructions: "test",
      adapter: { run: childRun },
      toolIndex: new Map(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any;

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: call private
      (plugin as any).runSubAgent(runState, child, { input: "go" }, 3),
    ).rejects.toThrow(/Sub-agent depth exceeded \(limit 2\)/);
    expect(childRun).not.toHaveBeenCalled();
  });

  test("forwards every sub-agent event into the parent stream except metadata", async () => {
    const plugin = new AgentsPlugin({ dir: false, agents: {} });
    const { runState, pushed } = makeRunState(plugin);

    const child = {
      name: "child",
      instructions: "test",
      adapter: {
        // biome-ignore lint/suspicious/noExplicitAny: stub adapter shape
        async *run(): any {
          yield { type: "metadata", data: { threadId: "child-thread" } };
          yield {
            type: "tool_call",
            id: "call-1",
            name: "highlight_period",
            arguments: '{"start":"2016-03-01","end":"2016-03-31"}',
          };
          yield { type: "tool_result", id: "call-1", output: "highlighted" };
          yield { type: "message_delta", content: "Done." };
        },
      },
      toolIndex: new Map(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any;

    // biome-ignore lint/suspicious/noExplicitAny: call private
    await (plugin as any).runSubAgent(runState, child, { input: "go" }, 1);

    const types = pushed.map((e) => (e as { type: string }).type);
    expect(types).not.toContain("metadata");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("message_delta");
  });

  test("nests the helper AGENT inside its dispatch TOOL and adds child usage once", async () => {
    const plugin = new AgentsPlugin({ dir: false, agents: {} });
    const { runState } = makeRunState(plugin);
    Object.assign(runState, {
      traceIdentity: {
        appName: "test-app",
        requestId: "request-1",
        route: "chat",
        sessionId: "session-1",
        userId: "alice",
      },
    });
    const helperStartedAt = Date.now();
    let childAdapterThreadId: string | undefined;
    const helper = {
      name: "helper",
      instructions: "research",
      adapter: {
        async *run(input: any, runContext: any): any {
          childAdapterThreadId = input.threadId;
          yield {
            type: "model_start",
            stepId: "helper-step",
            model: "helper.model",
            provider: "databricks",
            input: { messages: [{ role: "user", content: "research" }] },
            startedAt: helperStartedAt,
          };
          const fact = await runContext.executeTool("helper.tool", {
            topic: "tracing",
          });
          yield { type: "message_delta", content: `helper:${fact}` };
          yield {
            type: "model_end",
            stepId: "helper-step",
            model: "helper.model",
            provider: "databricks",
            output: { text: `helper:${fact}` },
            usage: {
              inputTokens: 6,
              outputTokens: 3,
              totalTokens: 9,
              costUsd: 0.02,
              costAvailable: true,
            },
            streamDurationMs: 5,
            endedAt: helperStartedAt + 5,
          };
        },
      },
      toolIndex: new Map<string, unknown>([
        [
          "helper.tool",
          {
            source: "function",
            def: {
              name: "helper.tool",
              description: "look up a fact",
              parameters: { type: "object" },
              annotations: { effect: "read" },
            },
            functionTool: {
              execute: async ({ topic }: { topic: string }) => `fact:${topic}`,
            },
          },
        ],
      ]),
    };
    (plugin as any).agents.set("helper", helper);
    const plannerToolIndex = new Map<string, unknown>([
      [
        "agent-helper",
        {
          source: "subagent",
          agentName: "helper",
          def: {
            name: "agent-helper",
            description: "delegate",
            parameters: { type: "object" },
          },
        },
      ],
    ]);
    const plannerStartedAt = Date.now();
    let aggregateUsage: unknown;

    const observed = await captureSpans(async () => {
      const traced = await runWithAgentTrace(
        {
          appName: "test-app",
          agentName: "planner",
          route: "chat",
          sessionId: "session-1",
          userId: "alice",
          requestId: "request-1",
          threadId: "planner-thread",
        },
        { message: "plan" },
        async (observer) => {
          Object.assign(runState, { traceObserver: observer });
          observer.onEvent({
            type: "model_start",
            stepId: "planner-step",
            model: "planner.model",
            provider: "databricks",
            input: { messages: [{ role: "user", content: "plan" }] },
            startedAt: plannerStartedAt,
          });
          const delegated = await callDispatch(plugin, {
            runState,
            toolIndex: plannerToolIndex,
            name: "agent-helper",
            args: { input: "research" },
          });
          observer.onEvent({
            type: "model_end",
            stepId: "planner-step",
            model: "planner.model",
            provider: "databricks",
            output: { text: String(delegated) },
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              totalTokens: 14,
              costUsd: 0.04,
              costAvailable: true,
            },
            streamDurationMs: 8,
            endedAt: plannerStartedAt + 8,
          });
          return delegated;
        },
      );
      aggregateUsage = traced.usage;
    });

    expect(observed.error).toBeUndefined();
    expect(aggregateUsage).toEqual({
      inputTokens: 16,
      outputTokens: 7,
      totalTokens: 23,
      costUsd: 0.06,
      costAvailable: true,
    });
    const agentSpans = observed.spans.filter(
      (span) => span.attributes["mlflow.spanType"] === "AGENT",
    );
    const toolSpans = observed.spans.filter(
      (span) => span.attributes["mlflow.spanType"] === "TOOL",
    );
    const planner = agentSpans.find(
      (span) => span.attributes["appkit.agent.name"] === "planner",
    );
    const child = agentSpans.find(
      (span) => span.attributes["appkit.agent.name"] === "helper",
    );
    const delegation = toolSpans.find(
      (span) => span.attributes["appkit.tool.name"] === "agent-helper",
    );
    const helperTool = toolSpans.find(
      (span) => span.attributes["appkit.tool.name"] === "helper.tool",
    );
    const helperModel = observed.spans.find(
      (span) => span.attributes["mlflow.chat.model"] === "helper.model",
    );
    expect(agentSpans).toHaveLength(2);
    expect(delegation?.parentSpanContext?.spanId).toBe(
      planner?.spanContext().spanId,
    );
    expect(child?.parentSpanContext?.spanId).toBe(
      delegation?.spanContext().spanId,
    );
    expect(helperModel?.parentSpanContext?.spanId).toBe(
      child?.spanContext().spanId,
    );
    expect(helperTool?.parentSpanContext?.spanId).toBe(
      child?.spanContext().spanId,
    );
    expect(child?.attributes).toMatchObject({
      "appkit.agent.name": "helper",
      "appkit.app.name": "test-app",
      "appkit.request.id": "request-1",
      "appkit.thread.id": childAdapterThreadId,
      "mlflow.trace.session": "session-1",
      "mlflow.trace.user": "alice",
    });
    expect(childAdapterThreadId).not.toBe("planner-thread");
    expect(planner?.attributes["mlflow.trace.tokenUsage"]).toBe(
      '{"input_tokens":16,"output_tokens":7,"total_tokens":23}',
    );
    expect(planner?.attributes["mlflow.llm.cost"]).toBe(0.06);
    expect(
      JSON.parse(String(delegation?.attributes["mlflow.spanOutputs"])),
    ).toBe("helper:fact:tracing");
  });

  test("adds failed unpriced child usage once and rethrows the original error", async () => {
    const plugin = new AgentsPlugin({ dir: false, agents: {} });
    const { runState } = makeRunState(plugin);
    const failure = new Error("helper failed after model usage");
    const startedAt = Date.now();
    const helper = {
      name: "helper",
      instructions: "research",
      adapter: {
        // biome-ignore lint/suspicious/noExplicitAny: stub adapter shape
        async *run(): any {
          yield {
            type: "model_start",
            stepId: "helper-step",
            model: "helper.model",
            provider: "databricks",
            input: { messages: [{ role: "user", content: "research" }] },
            startedAt,
          };
          yield {
            type: "model_end",
            stepId: "helper-step",
            model: "helper.model",
            provider: "databricks",
            output: { text: "partial research" },
            usage: {
              inputTokens: 6,
              outputTokens: 3,
              totalTokens: 9,
              costAvailable: false,
            },
            streamDurationMs: 5,
            endedAt: startedAt + 5,
          };
          throw failure;
        },
      },
      toolIndex: new Map(),
    };
    (plugin as any).agents.set("helper", helper);
    const plannerToolIndex = new Map<string, unknown>([
      [
        "agent-helper",
        {
          source: "subagent",
          agentName: "helper",
          def: {
            name: "agent-helper",
            description: "delegate",
            parameters: { type: "object" },
          },
        },
      ],
    ]);

    const observed = await captureSpans(() =>
      runWithAgentTrace(
        {
          appName: "test-app",
          agentName: "planner",
          route: "chat",
          sessionId: "session-1",
          userId: "alice",
          requestId: "request-1",
          threadId: "planner-thread",
        },
        { message: "plan" },
        async (observer) => {
          Object.assign(runState, { traceObserver: observer });
          observer.onEvent({
            type: "model_start",
            stepId: "planner-step",
            model: "planner.model",
            provider: "databricks",
            input: { messages: [{ role: "user", content: "plan" }] },
            startedAt,
          });
          observer.onEvent({
            type: "model_end",
            stepId: "planner-step",
            model: "planner.model",
            provider: "databricks",
            output: { text: "delegating" },
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              totalTokens: 14,
              costUsd: 0.04,
              costAvailable: true,
            },
            streamDurationMs: 8,
            endedAt: startedAt + 8,
          });
          return callDispatch(plugin, {
            runState,
            toolIndex: plannerToolIndex,
            name: "agent-helper",
            args: { input: "research" },
          });
        },
      ),
    );

    expect(observed.error).toBe(failure);
    const plannerSpan = observed.spans.find(
      (span) => span.attributes["appkit.agent.name"] === "planner",
    );
    expect(plannerSpan?.attributes["mlflow.trace.tokenUsage"]).toBe(
      '{"input_tokens":16,"output_tokens":7,"total_tokens":23}',
    );
    expect(plannerSpan?.attributes["appkit.cost.available"]).toBe(false);
    expect(plannerSpan?.attributes["mlflow.llm.cost"]).toBeUndefined();
  });
});
