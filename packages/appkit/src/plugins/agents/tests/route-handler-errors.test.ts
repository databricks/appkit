import type express from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CacheManager } from "../../../cache";
import { AgentsPlugin } from "../agents";

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

function seedPlugin(): AgentsPlugin {
  const plugin = new AgentsPlugin({ dir: false });
  // biome-ignore lint/suspicious/noExplicitAny: seed private state
  (plugin as any).agents.set("default", {
    name: "default",
    instructions: "hi",
    adapter: { async *run() {} },
    toolIndex: new Map(),
  });
  // biome-ignore lint/suspicious/noExplicitAny: seed private state
  (plugin as any).defaultAgentName = "default";
  return plugin;
}

describe("POST /chat — threadStore failure", () => {
  test("returns 500 when threadStore.get rejects (existing thread path)", async () => {
    const plugin = seedPlugin();
    // biome-ignore lint/suspicious/noExplicitAny: stub threadStore for failure
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
    // biome-ignore lint/suspicious/noExplicitAny: stub
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
    // biome-ignore lint/suspicious/noExplicitAny: stub
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
    // biome-ignore lint/suspicious/noExplicitAny: stub
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
    // biome-ignore lint/suspicious/noExplicitAny: stub
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
    // biome-ignore lint/suspicious/noExplicitAny: seed private state
    (plugin as any).agents.set("default", {
      name: "default",
      instructions: "hi",
      adapter: { async *run() {} },
      toolIndex,
    });
    // biome-ignore lint/suspicious/noExplicitAny: seed private state
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
    // biome-ignore lint/suspicious/noExplicitAny: stub the downstream runner to avoid running the adapter
    (plugin as any)._runAgentNonStreaming = vi.fn(async () => undefined);
    // biome-ignore lint/suspicious/noExplicitAny: stub
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
    // biome-ignore lint/suspicious/noExplicitAny: assert delegation
    expect((plugin as any)._runAgentNonStreaming).toHaveBeenCalled();
  });

  test("passes pre-flight when the agent has only read-only tools", async () => {
    const plugin = seedPluginWithTools({ effect: "read" });
    // biome-ignore lint/suspicious/noExplicitAny: stub the runner
    (plugin as any)._runAgentNonStreaming = vi.fn(async () => undefined);
    // biome-ignore lint/suspicious/noExplicitAny: stub
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
    // biome-ignore lint/suspicious/noExplicitAny: assert delegation
    expect((plugin as any)._runAgentNonStreaming).toHaveBeenCalled();
  });
});

describe("POST /invocations & /responses — successful invoke", () => {
  test("returns OpenAI Responses-shaped JSON with aggregated assistant text", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: seed
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
    // biome-ignore lint/suspicious/noExplicitAny: seed
    (plugin as any).defaultAgentName = "default";
    // biome-ignore lint/suspicious/noExplicitAny: stub
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
});

describe("/invocations and /responses are aliases", () => {
  test("both routes are registered and bound to the same handler", () => {
    const plugin = new AgentsPlugin({ dir: false });
    const addRoute = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: inject minimal fake context
    (plugin as any).context = { addRoute };
    // biome-ignore lint/suspicious/noExplicitAny: invoke private mounter
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
