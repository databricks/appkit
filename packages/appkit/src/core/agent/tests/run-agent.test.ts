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
import { fromPlugin } from "../from-plugin";
import { runAgent } from "../run-agent";
import { tool } from "../tools/tool";
import type { ToolkitEntry } from "../types";

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

  test("resolves fromPlugin markers against RunAgentInput.plugins", async () => {
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

    const factory = () => ({
      plugin: FakePlugin as unknown as PluginConstructor,
      config: {},
      name: "ping" as const,
    });
    Object.defineProperty(factory, "pluginName", {
      value: "ping",
      enumerable: true,
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
      tools: {
        ...fromPlugin(factory as unknown as { readonly pluginName: string }),
      },
    });

    const pluginData = factory() as PluginData<
      PluginConstructor,
      unknown,
      string
    >;

    await runAgent(def, { messages: "hi", plugins: [pluginData] });
    expect(capturedCtx).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = await capturedCtx!.executeTool("ping.ping", {});
    expect(result).toBe("pong");
    expect(pingExec).toHaveBeenCalled();
  });

  test("throws with guidance when fromPlugin marker has no matching plugin", async () => {
    const factory = () => ({ name: "absent" as const });
    Object.defineProperty(factory, "pluginName", {
      value: "absent",
      enumerable: true,
    });

    const adapter: AgentAdapter = {
      async *run(_input, _context) {
        yield { type: "message_delta", content: "" };
      },
    };

    const def = createAgent({
      instructions: "x",
      model: adapter,
      tools: {
        ...fromPlugin(factory as unknown as { readonly pluginName: string }),
      },
    });

    await expect(runAgent(def, { messages: "hi" })).rejects.toThrow(/absent/);
    await expect(runAgent(def, { messages: "hi" })).rejects.toThrow(
      /Available:/,
    );
  });

  test("throws a clear error when a ToolkitEntry is invoked", async () => {
    const toolkitEntry: ToolkitEntry = {
      __toolkitRef: true,
      pluginName: "analytics",
      localName: "query",
      def: {
        name: "analytics.query",
        description: "SQL",
        parameters: { type: "object", properties: {} },
      },
    };

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
      tools: { "analytics.query": toolkitEntry },
    });

    await runAgent(def, { messages: "hi" });
    expect(capturedCtx).not.toBeNull();
    await expect(
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      capturedCtx!.executeTool("analytics.query", {}),
    ).rejects.toThrow(/only usable via createApp/);
  });
});
