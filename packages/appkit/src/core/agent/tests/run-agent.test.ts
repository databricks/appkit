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
});
