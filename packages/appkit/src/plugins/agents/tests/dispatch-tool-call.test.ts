import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type express from "express";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CacheManager } from "../../../cache";
import { resolveSkillCatalog } from "../../../core/agent/skills/resolve-catalog";
import type { SkillDefinition } from "../../../core/agent/skills/types";
import { createTestPluginContext } from "../../../testing";
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

beforeEach(() => {
  // dispatchToolCall is exercised without going through setup(), so we
  // need the cache singleton to be initialised before the plugin reads it.
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

function mockReq(): express.Request {
  // Carry OBO headers so PluginContext.executeTool's asUser(req) resolves a
  // user scope (the mock context enforces the real token precondition).
  const headers: Record<string, string> = {
    "x-forwarded-access-token": "user-token",
    "x-forwarded-user": "alice",
  };
  return {
    body: {},
    headers,
    header: (name: string) => headers[name.toLowerCase()],
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

describe("dispatchToolCall — approval gate honours `effect`", () => {
  test('fires for `effect: "destructive"` even without legacy `destructive: true`', async () => {
    // Regression for finding #1 on PR #304: the gate previously checked
    // only `annotations.destructive === true` and let `effect:"destructive"`
    // through unapproved.
    const plugin = new AgentsPlugin({});
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

    (plugin as any).approvalGate.wait = vi.fn().mockResolvedValue("approve");

    await callDispatch(plugin, {
      runState,
      toolIndex,
      name: "drop_table",
      args: {},
    });

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
      const plugin = new AgentsPlugin({});
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

      (plugin as any).approvalGate.wait = vi.fn();

      await callDispatch(plugin, {
        runState,
        toolIndex,
        name: "select",
        args: {},
      });

      expect((plugin as any).approvalGate.wait).toHaveBeenCalledTimes(
        expectGate ? 1 : 0,
      );
    },
  );

  test("denying the gate returns the deny string and does not invoke the tool", async () => {
    const plugin = new AgentsPlugin({});
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
    const plugin = new AgentsPlugin({});
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
  const toolkitToolIndex = () =>
    new Map<string, unknown>([
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

  test("forwards runState.limits.toolCallTimeoutMs to PluginContext.executeTool", async () => {
    const plugin = new AgentsPlugin({});
    const { runState } = makeRunState(plugin);
    runState.limits.toolCallTimeoutMs = 90_000;

    // Use the real PluginContext via the testing kit rather than a bare
    // `{ executeTool }` stub. `executeTool` here is the real method, so the
    // forwarded timeout is exercised through actual signal composition — and
    // spying on it lets us keep asserting the exact call signature the agents
    // plugin passes.
    const mock = createTestPluginContext({ analytics: { query: "rows" } });
    const executeToolSpy = vi.spyOn(mock.ctx, "executeTool");
    await mock.attach(plugin);

    const result = await callDispatch(plugin, {
      runState,
      toolIndex: toolkitToolIndex(),
      name: "analytics.query",
      args: { sql: "SELECT 1" },
    });

    expect(result).toBe("rows");
    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    const call = executeToolSpy.mock.calls[0];
    // (req, pluginName, toolName, args, signal, timeoutMs)
    expect(call[1]).toBe("analytics");
    expect(call[2]).toBe("query");
    expect(call[5]).toBe(90_000);

    // The stub could never prove this: the real executeTool routed the call
    // through the analytics provider's on-behalf-of (asUser) path.
    expect(mock.toolCalls).toHaveLength(1);
    expect(mock.toolCalls[0]).toMatchObject({
      plugin: "analytics",
      tool: "query",
      args: { sql: "SELECT 1" },
      asUser: true,
    });
  });

  test("the forwarded timeout actually aborts a slow toolkit tool", async () => {
    // End-to-end proof that the timeout value the agents plugin forwards
    // reaches real AbortSignal composition inside PluginContext.executeTool —
    // a stubbed executeTool would silently ignore the timeout.
    const plugin = new AgentsPlugin({});
    const { runState } = makeRunState(plugin);
    runState.limits.toolCallTimeoutMs = 5;

    const mock = createTestPluginContext({
      analytics: {
        query: (_args, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted by toolkit timeout")),
            );
          }),
      },
    });
    await mock.attach(plugin);

    await expect(
      callDispatch(plugin, {
        runState,
        toolIndex: toolkitToolIndex(),
        name: "analytics.query",
        args: { sql: "SELECT 1" },
      }),
    ).rejects.toThrow(/aborted by toolkit timeout/);
  });

  test("resolvedLimits exposes the documented 5-minute default", () => {
    const plugin = new AgentsPlugin({});
    const limits = (plugin as any).resolvedLimits;
    expect(limits.toolCallTimeoutMs).toBe(300_000);
  });

  test("honours agents({ limits: { toolCallTimeoutMs } })", () => {
    const plugin = new AgentsPlugin({
      limits: { toolCallTimeoutMs: 600_000 },
    });
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
    } as any;

    await expect(
      (plugin as any).runSubAgent(runState, child, { input: "go" }, 3),
    ).rejects.toThrow(/Sub-agent depth exceeded \(limit 2\)/);
    expect(childRun).not.toHaveBeenCalled();
  });

  test("forwards every sub-agent event into the parent stream except metadata", async () => {
    const plugin = new AgentsPlugin({ agents: {} });
    const { runState, pushed } = makeRunState(plugin);

    const child = {
      name: "child",
      instructions: "test",
      adapter: {
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
    } as any;

    await (plugin as any).runSubAgent(runState, child, { input: "go" }, 1);

    const types = pushed.map((e) => (e as { type: string }).type);
    expect(types).not.toContain("metadata");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("message_delta");
  });
});

describe("dispatchToolCall — skill built-ins", () => {
  let skillDir = "";

  afterEach(() => {
    if (skillDir) {
      fs.rmSync(skillDir, { recursive: true, force: true });
      skillDir = "";
    }
  });

  function skillCatalog(skills: SkillDefinition[]) {
    return resolveSkillCatalog({
      agentName: "a",
      perAgentSkills: skills,
      globalSkills: [],
      autoInherit: false,
    });
  }

  function skillToolIndex(
    catalog: ReturnType<typeof skillCatalog>,
  ): Map<string, unknown> {
    const readOnly = { effect: "read" as const };
    return new Map<string, unknown>([
      [
        "load_skill",
        {
          source: "skill",
          builtin: "load_skill",
          catalog,
          def: {
            name: "load_skill",
            description: "load",
            parameters: { type: "object" },
            annotations: readOnly,
          },
        },
      ],
      [
        "read_skill_file",
        {
          source: "skill",
          builtin: "read_skill_file",
          catalog,
          def: {
            name: "read_skill_file",
            description: "read",
            parameters: { type: "object" },
            annotations: readOnly,
          },
        },
      ],
    ]);
  }

  test("load_skill returns the skill body + manifest and skips the gate", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);
    const catalog = skillCatalog([
      {
        name: "pdf",
        description: "d",
        body: "Detailed PDF steps.",
        source: "bundle-agent",
        dir: "/fake/pdf",
        files: ["reference.md"],
      },
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: stub gate to assert it never fires
    (plugin as any).approvalGate.wait = vi.fn();

    const result = await callDispatch(plugin, {
      runState,
      toolIndex: skillToolIndex(catalog),
      name: "load_skill",
      args: { skill: "pdf" },
    });

    expect(String(result)).toContain("Detailed PDF steps.");
    expect(String(result)).toContain("reference.md");
    // biome-ignore lint/suspicious/noExplicitAny: assertion on stub
    expect((plugin as any).approvalGate.wait).not.toHaveBeenCalled();
  });

  test("load_skill errors on an unknown skill name", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);
    const catalog = skillCatalog([
      {
        name: "pdf",
        description: "d",
        body: "b",
        source: "bundle-agent",
        dir: "/fake/pdf",
        files: [],
      },
    ]);

    await expect(
      callDispatch(plugin, {
        runState,
        toolIndex: skillToolIndex(catalog),
        name: "load_skill",
        args: { skill: "ghost" },
      }),
    ).rejects.toThrow(/Unknown skill/);
  });

  test("read_skill_file reads a listed file and rejects an unlisted path", async () => {
    skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-dispatch-"));
    fs.writeFileSync(
      path.join(skillDir, "reference.md"),
      "the reference",
      "utf-8",
    );
    const plugin = new AgentsPlugin({ dir: false });
    const { runState } = makeRunState(plugin);
    const catalog = skillCatalog([
      {
        name: "pdf",
        description: "d",
        body: "b",
        source: "bundle-agent",
        dir: skillDir,
        files: ["reference.md"],
      },
    ]);
    const toolIndex = skillToolIndex(catalog);

    await expect(
      callDispatch(plugin, {
        runState,
        toolIndex,
        name: "read_skill_file",
        args: { skill: "pdf", path: "reference.md" },
      }),
    ).resolves.toContain("the reference");

    await expect(
      callDispatch(plugin, {
        runState,
        toolIndex,
        name: "read_skill_file",
        args: { skill: "pdf", path: "../secret" },
      }),
    ).rejects.toThrow();
  });
});
