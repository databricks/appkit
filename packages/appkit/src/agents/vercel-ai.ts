import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
} from "shared";

/**
 * Adapter bridging the Vercel AI SDK (`ai` package) to the AppKit agent protocol.
 *
 * Converts `AgentToolDefinition[]` to Vercel AI tool format and maps
 * `streamText().fullStream` events to `AgentEvent`.
 *
 * Requires `ai` as an optional peer dependency.
 *
 * @example
 * ```ts
 * import { VercelAIAdapter } from "@databricks/appkit/agents/vercel-ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * appkit.agent.registerAgent("assistant", new VercelAIAdapter({ model: openai("gpt-4o") }));
 * ```
 */
export class VercelAIAdapter implements AgentAdapter {
  private model: any;

  constructor(options: { model: any }) {
    this.model = options.model;
  }

  async *run(
    input: AgentInput,
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const { streamText } = await import("ai");
    const { jsonSchema } = await import("ai");

    const tools = this.buildTools(input.tools, context, jsonSchema);

    const messages = input.messages.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));

    yield { type: "status", status: "running" };

    const result = streamText({
      model: this.model,
      messages,
      tools,
      maxSteps: 10 as any,
      abortSignal: input.signal,
    } as any);

    for await (const part of (result as any).fullStream) {
      if (context.signal?.aborted) break;

      switch (part.type) {
        case "text-delta":
          yield { type: "message_delta", content: part.textDelta };
          break;

        case "tool-call":
          yield {
            type: "tool_call",
            callId: part.toolCallId,
            name: part.toolName,
            args: part.args,
          };
          break;

        case "tool-result":
          yield {
            type: "tool_result",
            callId: part.toolCallId,
            result: part.result,
          };
          break;

        case "reasoning":
          if (part.textDelta) {
            yield { type: "thinking", content: part.textDelta };
          }
          break;

        case "error":
          yield {
            type: "status",
            status: "error",
            error: String(part.error),
          };
          break;
      }
    }
  }

  private buildTools(
    definitions: AgentToolDefinition[],
    context: AgentRunContext,
    jsonSchema: any,
  ): Record<string, any> {
    const tools: Record<string, any> = {};

    for (const def of definitions) {
      tools[def.name] = {
        description: def.description,
        parameters: jsonSchema(def.parameters),
        execute: async (args: unknown) => {
          try {
            return await context.executeTool(def.name, args);
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Tool execution failed",
            };
          }
        },
      };
    }

    return tools;
  }
}
