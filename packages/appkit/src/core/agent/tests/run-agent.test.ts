import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
  PluginConstructor,
  PluginData,
  ToolProvider,
} from "shared";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../create-agent";
import { runAgent } from "../run-agent";
import { mcpServer } from "../tools/hosted-tools";
import { tool } from "../tools/tool";

function scriptedAdapter(events: AgentEvent[]): AgentAdapter {
  return {
    async *run(_input: AgentInput, _context: AgentRunContext) {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("runAgent", () => {
  test("drives the adapter and returns aggregated text", async () => {
    const events: AgentEvent[] = [
      { type: "message_delta", content: "Hello " },
      { type: "message_delta", content: "world" },
      { type: "status", status: "complete" },
    ];
    const def = createAgent({
      instructions: "Say hello",
      model: scriptedAdapter(events),
    });

    const result = await runAgent(def, { messages: "hi" });
    expect(result.text).toBe("Hello world");
    expect(result.events).toHaveLength(3);
  });

  test("prefers terminal 'message' event over deltas when present", async () => {
    const events: AgentEvent[] = [
      { type: "message_delta", content: "partial" },
      { type: "message", content: "final answer" },
    ];
    const def = createAgent({
      instructions: "x",
      model: scriptedAdapter(events),
    });
    const result = await runAgent(def, { messages: "hi" });
    expect(result.text).toBe("final answer");
  });

  test("invokes inline tools via executeTool callback", async () => {
    const weatherFn = vi.fn(async () => "Sunny in NYC");
    const weather = tool({
      name: "get_weather",
      description: "Weather",
      schema: z.object({ city: z.string() }),
      execute: weatherFn,
    });

    let capturedCtx: AgentRunContext | null = null;
    const adapter: AgentAdapter = {
      async *run(_input, context) {
        capturedCtx = context;
        yield { type: "message_delta", content: "" };
      },
    };

    const def = createAgent({
      instructions: "x",
      model: adapter,
      tools: { get_weather: weather },
    });

    await runAgent(def, { messages: "hi" });
    expect(capturedCtx).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await capturedCtx!.executeTool("get_weather", {
      city: "NYC",
    });
    expect(result).toBe("Sunny in NYC");
    expect(weatherFn).toHaveBeenCalledWith({ city: "NYC" });
  });

  test("function-form tools(plugins) resolves toolkit() against RunAgentInput.plugins", async () => {
    const pingExec = vi.fn(async () => "pong");
    class FakePlugin implements ToolProvider {
      static manifest = { name: "ping" };
      static DEFAULT_CONFIG = {};
      name = "ping";
      constructor(public config: unknown) {}
      async setup() {}
      injectRoutes() {}
      getEndpoints() {
        return {};
      }
      getAgentTools(): AgentToolDefinition[] {
        return [
          {
            name: "ping",
            description: "ping",
            parameters: { type: "object", properties: {} },
          },
        ];
      }
      executeAgentTool = pingExec;
    }

    let capturedCtx: AgentRunContext | null = null;
    const adapter: AgentAdapter = {
      async *run(_input, context) {
        capturedCtx = context;
        yield { type: "message_delta", content: "" };
      },
    };

    const def = createAgent({
      instructions: "x",
      model: adapter,
      tools(plugins) {
        return { ...plugins.ping.toolkit() };
      },
    });

    const pluginData: PluginData<PluginConstructor, unknown, string> = {
      plugin: FakePlugin as unknown as PluginConstructor,
      config: {},
      name: "ping",
    };

    await runAgent(def, { messages: "hi", plugins: [pluginData] });
    expect(capturedCtx).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await capturedCtx!.executeTool("ping.ping", {});
    expect(result).toBe("pong");
    expect(pingExec).toHaveBeenCalled();
  });

  test("function-form throws with guidance when a referenced plugin is missing", async () => {
    const adapter: AgentAdapter = {
      async *run(_input, _context) {
        yield { type: "message_delta", content: "" };
      },
    };

    const def = createAgent({
      instructions: "x",
      model: adapter,
      tools(plugins) {
        return { ...plugins.absent.toolkit() };
      },
    });

    // No plugins passed → plugins.absent is undefined → toolkit() call throws.
    await expect(runAgent(def, { messages: "hi" })).rejects.toThrow(
      /tools\(plugins\) callback threw/,
    );
  });

  test("function-form rejects a plugin lacking ToolProvider methods", async () => {
    class NotAToolProvider {
      static manifest = { name: "noop" };
      static DEFAULT_CONFIG = {};
      name = "noop";
      constructor(public config: unknown) {}
      async setup() {}
      injectRoutes() {}
      getEndpoints() {
        return {};
      }
    }

    const adapter: AgentAdapter = {
      async *run(_input, _context) {
        yield { type: "message_delta", content: "" };
      },
    };

    const def = createAgent({
      instructions: "x",
      model: adapter,
      tools(plugins) {
        return { ...plugins.noop.toolkit() };
      },
    });

    const pluginData: PluginData<PluginConstructor, unknown, string> = {
      plugin: NotAToolProvider as unknown as PluginConstructor,
      config: {},
      name: "noop",
    };

    await expect(
      runAgent(def, { messages: "hi", plugins: [pluginData] }),
    ).rejects.toThrow(/not a ToolProvider/);
  });

  test("rejects hosted/MCP tools at index-build time, not at dispatch", async () => {
    // Pre-condition for #305 review finding #3: a hosted tool slipped into
    // an agent def used with standalone runAgent must surface a clear error
    // before the adapter sees the tool list — not later when the model
    // emits a function_call mid-conversation.
    const def = createAgent({
      instructions: "x",
      // biome-ignore lint/suspicious/noExplicitAny: stub adapter — we never reach it
      model: { async *run() {} } as any,
      tools: {
        analytics: mcpServer("analytics-mcp", "https://example.com/mcp"),
      },
    });

    await expect(runAgent(def, { messages: "hi" })).rejects.toThrow(
      /hosted tool .* only supported via createApp/,
    );
  });

  test("recursively executes sub-agents declared on def.agents", async () => {
    // Pre-condition for #305 review finding #8: parent's `agent-<key>` tool
    // call should kick a nested runAgent that returns the child's text
    // output as the tool result.
    const childAdapter: AgentAdapter = {
      async *run(_input, _context) {
        yield { type: "message_delta", content: "child says hi" };
      },
    };

    let capturedCtx: AgentRunContext | null = null;
    const parentAdapter: AgentAdapter = {
      async *run(_input, context) {
        capturedCtx = context;
        yield { type: "message_delta", content: "" };
      },
    };

    const parent = createAgent({
      instructions: "parent",
      model: parentAdapter,
      agents: {
        helper: createAgent({
          instructions: "child",
          model: childAdapter,
        }),
      },
    });

    await runAgent(parent, { messages: "go" });
    expect(capturedCtx).not.toBeNull();
    const result =
      await // biome-ignore lint/style/noNonNullAssertion: asserted above
      capturedCtx!.executeTool("agent-helper", { input: "say hi" });
    expect(result).toBe("child says hi");
  });

  test("function-form invoked exactly once per runAgent call", async () => {
    const toolsFn = vi.fn(() => ({}));
    const adapter: AgentAdapter = {
      async *run(_input, _context) {
        yield { type: "message_delta", content: "" };
      },
    };
    const def = createAgent({
      instructions: "x",
      model: adapter,
      tools: toolsFn,
    });
    await runAgent(def, { messages: "hi" });
    expect(toolsFn).toHaveBeenCalledTimes(1);
  });

  test("function-form names the missing plugin in the error (proxy)", async () => {
    // Regression: previously `plugins.absent` was undefined, and accessing
    // `.toolkit()` on it produced a generic "Cannot read properties of
    // undefined" — no plugin name, no list of available names. The proxy
    // now throws a clear "not registered. Available: ..." error.
    const adapter: AgentAdapter = {
      async *run(_input, _context) {
        yield { type: "message_delta", content: "" };
      },
    };
    const def = createAgent({
      instructions: "x",
      model: adapter,
      tools(plugins) {
        return { ...plugins.absent.toolkit() };
      },
    });
    await expect(runAgent(def, { messages: "hi" })).rejects.toThrow(/'absent'/);
    await expect(runAgent(def, { messages: "hi" })).rejects.toThrow(
      /not registered/,
    );
    await expect(runAgent(def, { messages: "hi" })).rejects.toThrow(
      /Available/,
    );
  });

  test("plugin setup() failure surfaces at runAgent entry, not mid-stream", async () => {
    // Regression: previously plugins were constructed lazily during the
    // function form's toolkit() call, and setup() was never invoked. That
    // pushed any setup-time failure (e.g. `getWorkspaceClient is not
    // initialised`) into mid-conversation tool dispatches with confusing
    // stack traces. The fix: eagerly attachContext + setup at runAgent
    // entry; failures wrap with a "use createApp instead" hint.
    class BadSetupPlugin {
      static manifest = { name: "bad" };
      static DEFAULT_CONFIG = {};
      name = "bad";
      constructor(public config: unknown) {}
      async setup() {
        throw new Error("WorkspaceClient not initialised");
      }
      injectRoutes() {}
      getEndpoints() {
        return {};
      }
      getAgentTools() {
        return [];
      }
      async executeAgentTool() {
        return null;
      }
    }
    const adapter: AgentAdapter = {
      async *run(_input, _context) {
        // Should never reach the adapter.
        yield { type: "message_delta", content: "this should not run" };
      },
    };
    const def = createAgent({
      instructions: "x",
      model: adapter,
      tools(plugins) {
        return { ...plugins.bad.toolkit() };
      },
    });
    const pluginData: PluginData<PluginConstructor, unknown, string> = {
      plugin: BadSetupPlugin as unknown as PluginConstructor,
      config: {},
      name: "bad",
    };

    await expect(
      runAgent(def, { messages: "hi", plugins: [pluginData] }),
    ).rejects.toThrow(/setup\(\) failed in standalone mode/);
    await expect(
      runAgent(def, { messages: "hi", plugins: [pluginData] }),
    ).rejects.toThrow(/createApp/);
  });

  test("sub-agent recursion shares the same plugin instance with the parent", async () => {
    // Regression: providerCache used to be per-call inside
    // buildStandaloneToolIndex, so each nested runAgent constructed fresh
    // plugin instances and parent/child diverged in-instance state.
    let constructorCount = 0;
    class StatefulPlugin {
      static manifest = { name: "stateful" };
      static DEFAULT_CONFIG = {};
      name = "stateful";
      readonly id = ++constructorCount;
      constructor(public config: unknown) {}
      async setup() {}
      injectRoutes() {}
      getEndpoints() {
        return {};
      }
      getAgentTools() {
        return [
          {
            name: "whoami",
            description: "return instance id",
            parameters: { type: "object", properties: {} },
          },
        ];
      }
      async executeAgentTool() {
        return String(this.id);
      }
    }

    const childAdapter: AgentAdapter = {
      async *run(_input, context) {
        const id = await context.executeTool("stateful.whoami", {});
        yield { type: "message_delta", content: `child-id=${id}` };
      },
    };
    const parentAdapter: AgentAdapter = {
      async *run(_input, context) {
        const myId = await context.executeTool("stateful.whoami", {});
        const childOut = await context.executeTool("agent-child", {
          input: "go",
        });
        yield {
          type: "message_delta",
          content: `parent-id=${myId};${childOut}`,
        };
      },
    };

    const child = createAgent({
      instructions: "child",
      model: childAdapter,
      tools(plugins) {
        return { ...plugins.stateful.toolkit() };
      },
    });
    const parent = createAgent({
      instructions: "parent",
      model: parentAdapter,
      agents: { child },
      tools(plugins) {
        return { ...plugins.stateful.toolkit() };
      },
    });

    const pluginData: PluginData<PluginConstructor, unknown, string> = {
      plugin: StatefulPlugin as unknown as PluginConstructor,
      config: {},
      name: "stateful",
    };

    constructorCount = 0;
    const result = await runAgent(parent, {
      messages: "go",
      plugins: [pluginData],
    });

    // Plugin constructed exactly once across parent + child.
    expect(constructorCount).toBe(1);
    // Both parent and child reported the same instance id.
    expect(result.text).toBe("parent-id=1;child-id=1");
  });
});
