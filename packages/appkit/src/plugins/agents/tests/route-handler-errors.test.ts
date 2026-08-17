import type express from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { CacheManager } from "../../../cache";
import { AgentsPlugin } from "../agents";

// Partial-mock the tracing module: traceAgent/traceTool still run their
// callbacks, but the trace id is deterministic and run-linking is a spy.
const linkTraceToRun = vi.hoisted(() => vi.fn());
let mockTraceId: string | undefined;
vi.mock("../mlflow", () => ({
  initAgentTracing: vi.fn(async () => {}),
  traceAgent: (
    _name: string,
    _inputs: unknown,
    fn: (span: { setOutputs: () => void }) => Promise<unknown>,
  ) => fn({ setOutputs: () => {} }),
  traceTool: (
    _name: string,
    _inputs: unknown,
    fn: (span: { setOutputs: () => void }) => Promise<unknown>,
  ) => fn({ setOutputs: () => {} }),
  currentTraceId: () => mockTraceId,
  linkTraceToRun,
}));

/**
 * Surface-level guarantees on the agents plugin's HTTP route handlers when
 * downstream dependencies fail. Prior to PR #305 review finding #1+#2,
 * `_handleChat` and `_handleInvoke` (then `_handleInvocations`) awaited
 * `threadStore` without a try/catch — a backing-store failure (DB
 * unreachable, permission error) would propagate the rejection without
 * writing a response and the client would hang until the upstream proxy
 * timeout.
 *
 * Also covers the HITL pre-flight gate on `/invocations` and `/responses`:
 * the non-streaming invoke surface cannot run approval prompts mid-call,
 * so an agent whose tool surface contains approval-gated tools must be
 * rejected up-front with HTTP 400.
 */

beforeEach(() => {
  linkTraceToRun.mockClear();
  mockTraceId = undefined;
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

function mockReq(body: unknown, userId = "alice"): express.Request {
  const headers: Record<string, string> = {
    "x-forwarded-user": userId,
    "x-forwarded-access-token": "fake-token",
  };
  return {
    body,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as express.Request;
}

function mockRes() {
  const json = vi.fn();
  const setHeader = vi.fn();
  let statusCode = 200;
  const status = vi.fn((code: number) => {
    statusCode = code;
    return { json };
  });
  return {
    res: { status, json, setHeader } as unknown as express.Response,
    get statusCode() {
      return statusCode;
    },
    json,
  };
}

function seedPlugin(adapter: unknown = { async *run() {} }): AgentsPlugin {
  const plugin = new AgentsPlugin({ dir: false });
  (plugin as any).agents.set("default", {
    name: "default",
    instructions: "hi",
    adapter,
    toolIndex: new Map(),
  });
  (plugin as any).defaultAgentName = "default";
  return plugin;
}

describe("POST /chat — threadStore failure", () => {
  test("returns 500 when threadStore.get rejects (existing thread path)", async () => {
    const plugin = seedPlugin();
    (plugin as any).threadStore = {
      get: vi.fn().mockRejectedValue(new Error("DB unreachable")),
      create: vi.fn(),
      addMessage: vi.fn(),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi", threadId: "t-1" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });

  test("returns 500 when threadStore.create rejects (new-thread path)", async () => {
    const plugin = seedPlugin();
    (plugin as any).threadStore = {
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(new Error("Disk full")),
      addMessage: vi.fn(),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });

  test("returns 500 when threadStore.addMessage rejects", async () => {
    const plugin = seedPlugin();
    (plugin as any).threadStore = {
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "t-new", messages: [] }),
      addMessage: vi.fn().mockRejectedValue(new Error("Quota exceeded")),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });
});

describe("POST /invocations — threadStore failure", () => {
  test("returns 500 when threadStore.create rejects", async () => {
    const plugin = seedPlugin();
    (plugin as any).threadStore = {
      create: vi.fn().mockRejectedValue(new Error("DB unreachable")),
      addMessage: vi.fn(),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvoke: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvoke(mockReq({ input: "hi" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });

  test("returns 500 when threadStore.addMessage rejects mid-loop", async () => {
    const plugin = seedPlugin();
    (plugin as any).threadStore = {
      create: vi.fn().mockResolvedValue({ id: "t-new", messages: [] }),
      addMessage: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Conflict")),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvoke: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvoke(
      mockReq({
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Thread operation failed" });
  });
});

describe("POST /invocations & /responses — HITL pre-flight", () => {
  function seedPluginWithTools(
    toolAnnotations: Record<string, unknown>,
    overrides: ConstructorParameters<typeof AgentsPlugin>[0] = { dir: false },
  ): AgentsPlugin {
    const plugin = new AgentsPlugin(overrides);
    const toolIndex = new Map();
    toolIndex.set("dangerous_tool", {
      source: "function",
      def: {
        name: "dangerous_tool",
        description: "writes things",
        parameters: { type: "object", properties: {} },
        annotations: toolAnnotations,
      },
    });
    (plugin as any).agents.set("default", {
      name: "default",
      instructions: "hi",
      adapter: { async *run() {} },
      toolIndex,
    });
    (plugin as any).defaultAgentName = "default";
    return plugin;
  }

  test("rejects with 400 when a tool has effect: destructive", async () => {
    const plugin = seedPluginWithTools({ effect: "destructive" });
    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvoke: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvoke(mockReq({ input: "hi" }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/dangerous_tool/),
      }),
    );
  });

  test("rejects with 400 when a tool has legacy destructive: true", async () => {
    const plugin = seedPluginWithTools({ destructive: true });
    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvoke: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvoke(mockReq({ input: "hi" }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/approval-gated tool/),
      }),
    );
  });

  test("rejects with 400 when a tool has effect: write or update", async () => {
    for (const effect of ["write", "update"] as const) {
      const plugin = seedPluginWithTools({ effect });
      const { res } = mockRes();
      await (
        plugin as unknown as {
          _handleInvoke: (
            r: express.Request,
            w: express.Response,
          ) => Promise<void>;
        }
      )._handleInvoke(mockReq({ input: "hi" }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  test("passes pre-flight when approval.requireForDestructive is disabled", async () => {
    const plugin = seedPluginWithTools(
      { effect: "destructive" },
      { dir: false, approval: { requireForDestructive: false } },
    );
    (plugin as any)._runAgentNonStreaming = vi.fn(async () => undefined);
    (plugin as any).threadStore = {
      create: vi.fn().mockResolvedValue({ id: "t-1", messages: [] }),
      addMessage: vi.fn(),
    };

    const { res } = mockRes();
    await (
      plugin as unknown as {
        _handleInvoke: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvoke(mockReq({ input: "hi" }), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect((plugin as any)._runAgentNonStreaming).toHaveBeenCalled();
  });

  test("passes pre-flight when the agent has only read-only tools", async () => {
    const plugin = seedPluginWithTools({ effect: "read" });
    (plugin as any)._runAgentNonStreaming = vi.fn(async () => undefined);
    (plugin as any).threadStore = {
      create: vi.fn().mockResolvedValue({ id: "t-1", messages: [] }),
      addMessage: vi.fn(),
    };

    const { res } = mockRes();
    await (
      plugin as unknown as {
        _handleInvoke: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvoke(mockReq({ input: "hi" }), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect((plugin as any)._runAgentNonStreaming).toHaveBeenCalled();
  });
});

describe("POST /invocations & /responses — successful invoke", () => {
  test("returns OpenAI Responses-shaped JSON with aggregated assistant text", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    (plugin as any).agents.set("default", {
      name: "default",
      instructions: "hi",
      adapter: {
        async *run() {
          yield { type: "message_delta", content: "hello " };
          yield { type: "message_delta", content: "world" };
        },
      },
      toolIndex: new Map(),
    });
    (plugin as any).defaultAgentName = "default";
    (plugin as any).threadStore = {
      create: vi.fn().mockResolvedValue({ id: "t-new", messages: [] }),
      addMessage: vi.fn(),
      delete: vi.fn(),
    };

    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvoke: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvoke(mockReq({ input: "hi" }), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0]?.[0] as {
      id: string;
      object: string;
      status: string;
      thread_id: string;
      output: Array<{
        type: string;
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
    };
    expect(payload.object).toBe("response");
    expect(payload.status).toBe("completed");
    expect(payload.thread_id).toBe("t-new");
    expect(payload.id).toMatch(/^resp_/);
    expect(payload.output).toHaveLength(1);
    expect(payload.output[0]?.type).toBe("message");
    expect(payload.output[0]?.role).toBe("assistant");
    expect(payload.output[0]?.content[0]).toEqual({
      type: "output_text",
      text: "hello world",
    });
  });

  function seedEchoPlugin(): AgentsPlugin {
    const plugin = seedPlugin({
      async *run() {
        yield { type: "message_delta", content: "ok" };
      },
    });
    (plugin as any).threadStore = {
      create: vi.fn().mockResolvedValue({ id: "t-new", messages: [] }),
      addMessage: vi.fn(),
      delete: vi.fn(),
    };
    return plugin;
  }

  async function invoke(
    plugin: AgentsPlugin,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const { res, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvoke: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvoke(mockReq(body), res);
    return json.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  test("links the trace to the run and echoes mlflow_trace_id when tracing is on", async () => {
    mockTraceId = "tr-abc123";
    const plugin = seedEchoPlugin();

    const payload = await invoke(plugin, {
      input: "hi",
      mlflowRunId: "run-99",
    });

    expect(linkTraceToRun).toHaveBeenCalledWith("run-99");
    expect(payload.mlflow_trace_id).toBe("tr-abc123");
  });

  test("omits mlflow_trace_id and does not link when tracing is off", async () => {
    mockTraceId = undefined; // currentTraceId() no-ops when disabled
    const plugin = seedEchoPlugin();

    const payload = await invoke(plugin, { input: "hi" });

    expect(linkTraceToRun).not.toHaveBeenCalled();
    expect(payload).not.toHaveProperty("mlflow_trace_id");
  });

  test("does not link when no run id is supplied even if tracing is on", async () => {
    mockTraceId = "tr-standalone";
    const plugin = seedEchoPlugin();

    const payload = await invoke(plugin, { input: "hi" });

    expect(linkTraceToRun).not.toHaveBeenCalled();
    // Trace still exists and its id is surfaced — just not linked to a run.
    expect(payload.mlflow_trace_id).toBe("tr-standalone");
  });
});

describe("/invocations and /responses are aliases", () => {
  test("both routes are registered and bound to the same handler", () => {
    const plugin = new AgentsPlugin({ dir: false });
    const addRoute = vi.fn();
    (plugin as any).context = { addRoute };
    (plugin as any).mountInvokeRoutes();

    expect(addRoute).toHaveBeenCalledTimes(2);
    const calls = addRoute.mock.calls.map((c: unknown[]) => ({
      method: c[0],
      path: c[1],
      handler: c[2],
    }));
    const invocations = calls.find(
      (c: { path: unknown }) => c.path === "/invocations",
    );
    const responses = calls.find(
      (c: { path: unknown }) => c.path === "/responses",
    );
    expect(invocations?.method).toBe("post");
    expect(responses?.method).toBe("post");
    // The two routes are aliases — same handler reference is mounted on both.
    expect(invocations?.handler).toBe(responses?.handler);
  });
});
