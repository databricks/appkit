import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
} from "shared";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { tool } from "../../../core/agent/tools/tool";
import type { ToolkitEntry } from "../../../core/agent/types";
import { createAgent } from "../create-agent";
import { runAgent } from "../run-agent";

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
