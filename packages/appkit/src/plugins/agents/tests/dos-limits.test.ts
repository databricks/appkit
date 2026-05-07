import type express from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CacheManager } from "../../../cache";
import { AgentsPlugin } from "../agents";
import { chatRequestSchema, invocationsRequestSchema } from "../schemas";

/**
 * Exercises the four DoS caps landed for MVP:
 *
 *   - `chatRequestSchema.message.max(64_000)` — body cap on `POST /chat`.
 *   - Per-user `maxConcurrentStreamsPerUser` — 429 with Retry-After.
 *   - Per-run `maxToolCalls` — aborts stream and throws in `executeTool`.
 *   - Per-delegation `maxSubAgentDepth` — rejects in `runSubAgent`.
 *
 * Route-level tests exercise the schemas + `_handleChat` directly via the
 * mocked req/res pattern already used by approval-route.test.ts.
 */

function mockReq(body: unknown, userId?: string): express.Request {
  const headers: Record<string, string> = {};
  if (userId) {
    headers["x-forwarded-user"] = userId;
    headers["x-forwarded-access-token"] = "fake-token";
  }
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
    setHeader,
  };
}

beforeEach(() => {
  CacheManager.getInstanceSync = vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(async (_k: unknown[], fn: () => Promise<unknown>) =>
      fn(),
    ),
    generateKey: vi.fn(() => "test-key"),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
  })) as any;
  process.env.NODE_ENV = "development";
});

describe("chatRequestSchema — body cap", () => {
  test("accepts messages up to 64_000 characters", () => {
    const result = chatRequestSchema.safeParse({
      message: "a".repeat(64_000),
    });
    expect(result.success).toBe(true);
  });

  test("rejects messages over 64_000 characters", () => {
    const result = chatRequestSchema.safeParse({
      message: "a".repeat(64_001),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.flatten())).toMatch(/64000/);
    }
  });

  test("rejects empty message (existing contract)", () => {
    expect(chatRequestSchema.safeParse({ message: "" }).success).toBe(false);
  });
});

describe("invocationsRequestSchema — input caps", () => {
  test("accepts string input up to 64_000 characters", () => {
    const result = invocationsRequestSchema.safeParse({
      input: "a".repeat(64_000),
    });
    expect(result.success).toBe(true);
  });

  test("rejects string input over 64_000 characters", () => {
    const result = invocationsRequestSchema.safeParse({
      input: "a".repeat(64_001),
    });
    expect(result.success).toBe(false);
  });

  test("accepts array input up to 100 items", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    expect(invocationsRequestSchema.safeParse({ input: items }).success).toBe(
      true,
    );
  });

  test("rejects array input over 100 items", () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    const result = invocationsRequestSchema.safeParse({ input: items });
    expect(result.success).toBe(false);
  });

  test("rejects per-item content over 64_000 characters", () => {
    const result = invocationsRequestSchema.safeParse({
      input: [{ role: "user", content: "a".repeat(64_001) }],
    });
    expect(result.success).toBe(false);
  });
});

describe("POST /chat — per-user concurrent-stream limit", () => {
  function seedPlugin(
    overrides: ConstructorParameters<typeof AgentsPlugin>[0] = { dir: false },
  ): AgentsPlugin {
    const plugin = new AgentsPlugin(overrides);
    // Seed the agents map directly so _handleChat can resolve "hello"
    // without running setup() (which would require a live model).
    // biome-ignore lint/suspicious/noExplicitAny: seeding private state
    (plugin as any).agents.set("hello", {
      name: "hello",
      instructions: "hi",
      adapter: { async *run() {} },
      toolIndex: new Map(),
    });
    // biome-ignore lint/suspicious/noExplicitAny: seeding private state
    (plugin as any).defaultAgentName = "hello";
    return plugin;
  }

  test("rejects with 429 + Retry-After when user is at-limit (default 5)", async () => {
    const plugin = seedPlugin();
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: seeding
      (plugin as any).activeStreams.set(`s${i}`, {
        controller: new AbortController(),
        userId: "alice",
      });
    }

    const { res, setHeader, json } = mockRes();
    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi" }, "alice"), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "5");
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/Too many concurrent streams/),
      }),
    );
  });

  test("does not reject when another user is at-limit (per-user, not global)", async () => {
    const plugin = seedPlugin();
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: seeding
      (plugin as any).activeStreams.set(`s${i}`, {
        controller: new AbortController(),
        userId: "alice",
      });
    }

    // Carol's request must not see a 429 even though alice is at-limit.
    // Don't bother running the full stream — we assert only that 429 is
    // not the response status.
    const { res } = mockRes();
    // biome-ignore lint/suspicious/noExplicitAny: stub _streamAgent to avoid needing a real adapter
    (plugin as any)._streamAgent = vi.fn(async () => undefined);

    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi" }, "carol"), res);

    expect(res.status).not.toHaveBeenCalledWith(429);
  });

  test("honours agents({ limits: { maxConcurrentStreamsPerUser } })", async () => {
    const plugin = seedPlugin({
      dir: false,
      limits: { maxConcurrentStreamsPerUser: 2 },
    });
    for (let i = 0; i < 2; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: seeding
      (plugin as any).activeStreams.set(`s${i}`, {
        controller: new AbortController(),
        userId: "alice",
      });
    }

    const { res } = mockRes();
    await (
      plugin as unknown as {
        _handleChat: (r: express.Request, w: express.Response) => Promise<void>;
      }
    )._handleChat(mockReq({ message: "hi" }, "alice"), res);

    expect(res.status).toHaveBeenCalledWith(429);
  });

  test("/invocations also honours maxConcurrentStreamsPerUser (no bypass)", async () => {
    // Regression for the agentic review finding: /invocations skipped the
    // rate-limit gate that /chat enforces, letting clients bypass the cap.
    const plugin = seedPlugin();
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: seeding
      (plugin as any).activeStreams.set(`s${i}`, {
        controller: new AbortController(),
        userId: "alice",
      });
    }

    const { res, setHeader, json } = mockRes();
    await (
      plugin as unknown as {
        _handleInvocations: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleInvocations(mockReq({ input: "hi" }, "alice"), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "5");
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/Too many concurrent streams/),
      }),
    );
  });
});

describe("resolvedLimits — default values", () => {
  test("exposes the documented MVP defaults when unconfigured", () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: read private getter
    const limits = (plugin as any).resolvedLimits;
    expect(limits).toEqual({
      maxConcurrentStreamsPerUser: 5,
      maxToolCalls: 50,
      maxSubAgentDepth: 3,
      toolCallTimeoutMs: 300_000,
    });
  });

  test("lets callers override any subset", () => {
    const plugin = new AgentsPlugin({
      dir: false,
      limits: { maxToolCalls: 100 },
    });
    // biome-ignore lint/suspicious/noExplicitAny: read private
    const limits = (plugin as any).resolvedLimits;
    expect(limits.maxToolCalls).toBe(100);
    expect(limits.maxConcurrentStreamsPerUser).toBe(5);
    expect(limits.maxSubAgentDepth).toBe(3);
  });
});

describe("runSubAgent — depth guard", () => {
  /**
   * Builds a minimal `RunState` matching the shape carried by `_streamAgent`
   * so we can drive `runSubAgent` directly against the depth guard.
   */
  function makeRunState(
    plugin: AgentsPlugin,
    overrides: Partial<{
      maxToolCalls: number;
      maxSubAgentDepth: number;
      maxConcurrentStreamsPerUser: number;
      toolCallTimeoutMs: number;
    }> = {},
  ) {
    const abortController = new AbortController();
    return {
      req: mockReq({}, "alice"),
      userId: "alice",
      requestId: "test-stream",
      abortController,
      signal: abortController.signal,
      approvalPolicy: { requireForDestructive: true, timeoutMs: 60_000 },
      limits: {
        maxConcurrentStreamsPerUser: overrides.maxConcurrentStreamsPerUser ?? 5,
        maxToolCalls: overrides.maxToolCalls ?? 50,
        maxSubAgentDepth: overrides.maxSubAgentDepth ?? 3,
        toolCallTimeoutMs: overrides.toolCallTimeoutMs ?? 300_000,
      },
      // The translator/channel are not exercised by the depth guard; stubbed
      // values are sufficient since the guard rejects before any dispatch.
      translator: {
        translate: () => [],
      },
      outboundEvents: {
        push: vi.fn(),
      },
      toolCallsUsed: { count: 0 },
    };
  }

  test("rejects when depth exceeds the configured maximum", async () => {
    const plugin = new AgentsPlugin({
      dir: false,
      limits: { maxSubAgentDepth: 2 },
    });
    const runState = makeRunState(plugin, { maxSubAgentDepth: 2 });
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: call private method directly
      (plugin as any).runSubAgent(
        runState,
        { name: "child", toolIndex: new Map() },
        {},
        3, // exceeds limit 2
      ),
    ).rejects.toThrow(/Sub-agent depth exceeded \(limit 2\)/);
  });

  test("accepts at the boundary (depth === limit)", async () => {
    const plugin = new AgentsPlugin({
      dir: false,
      limits: { maxSubAgentDepth: 3 },
      agents: {},
    });

    const stubAdapter = {
      // biome-ignore lint/suspicious/noExplicitAny: adapter shape not under test
      async *run(): any {
        yield { type: "message", content: "hello from depth-3" };
      },
    };
    const child = {
      name: "child",
      instructions: "test",
      // biome-ignore lint/suspicious/noExplicitAny: stub shape
      adapter: stubAdapter as any,
      toolIndex: new Map(),
    };

    const runState = makeRunState(plugin, { maxSubAgentDepth: 3 });
    // biome-ignore lint/suspicious/noExplicitAny: call private
    const result = await (plugin as any).runSubAgent(
      runState,
      child,
      { input: "test" },
      3, // at the limit, not over
    );
    expect(result).toBe("hello from depth-3");
  });
});
