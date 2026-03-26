import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
} from "shared";

/**
 * Adapter bridging LangChain/LangGraph to the AppKit agent protocol.
 *
 * Accepts any LangChain `Runnable` (e.g. AgentExecutor, compiled LangGraph)
 * and maps `streamEvents` v2 to `AgentEvent`.
 *
 * Requires `@langchain/core` as an optional peer dependency.
 *
 * @example
 * ```ts
 * import { LangChainAdapter } from "@databricks/appkit/agents/langchain";
 * import { ChatOpenAI } from "@langchain/openai";
 *
 * const model = new ChatOpenAI({ model: "gpt-4o" });
 * const agentExecutor = createReactAgent({ llm: model, tools: [] });
 * appkit.agent.registerAgent("assistant", new LangChainAdapter({ runnable: agentExecutor }));
 * ```
 */
export class LangChainAdapter implements AgentAdapter {
  private runnable: any;

  constructor(options: { runnable: any }) {
    this.runnable = options.runnable;
  }

  async *run(
    input: AgentInput,
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const lcTools = await import("@langchain/core/tools");
    const DynamicStructuredTool = lcTools.DynamicStructuredTool;
    const zodModule: any = await import("zod");
    const z = zodModule.z;

    const tools = this.buildTools(
      input.tools,
      context,
      DynamicStructuredTool,
      z,
    );

    const messages = input.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    yield { type: "status", status: "running" };

    const runnableWithTools =
      tools.length > 0 && typeof this.runnable.bindTools === "function"
        ? this.runnable.bindTools(tools)
        : this.runnable;

    const stream = await runnableWithTools.streamEvents(
      { messages },
      {
        version: "v2",
        signal: input.signal,
      },
    );

    for await (const event of stream) {
      if (context.signal?.aborted) break;

      switch (event.event) {
        case "on_chat_model_stream": {
          const chunk = event.data?.chunk;
          if (chunk?.content && typeof chunk.content === "string") {
            yield { type: "message_delta", content: chunk.content };
          }
          if (chunk?.tool_call_chunks) {
            for (const tc of chunk.tool_call_chunks) {
              if (tc.name) {
                yield {
                  type: "tool_call",
                  callId: tc.id ?? tc.name,
                  name: tc.name,
                  args: tc.args ? JSON.parse(tc.args) : {},
                };
              }
            }
          }
          break;
        }

        case "on_tool_end": {
          const output = event.data?.output;
          yield {
            type: "tool_result",
            callId: event.run_id,
            result: output?.content ?? output,
          };
          break;
        }

        case "on_chain_end": {
          const output = event.data?.output;
          if (output?.content && typeof output.content === "string") {
            yield { type: "message", content: output.content };
          }
          break;
        }
      }
    }
  }

  /**
   * Converts AgentToolDefinitions into LangChain DynamicStructuredTool instances.
   *
   * JSON Schema properties are mapped to Zod schemas using a lightweight
   * recursive converter for the subset of JSON Schema types that tools use.
   */
  private buildTools(
    definitions: AgentToolDefinition[],
    context: AgentRunContext,
    DynamicStructuredTool: any,
    z: any,
  ): any[] {
    return definitions.map(
      (def) =>
        new DynamicStructuredTool({
          name: def.name,
          description: def.description,
          schema: jsonSchemaToZod(def.parameters, z),
          func: async (args: unknown) => {
            try {
              const result = await context.executeTool(def.name, args);
              return typeof result === "string"
                ? result
                : JSON.stringify(result);
            } catch (error) {
              return `Error: ${error instanceof Error ? error.message : "Tool execution failed"}`;
            }
          },
        }),
    );
  }
}

/**
 * Lightweight JSON Schema (subset) to Zod converter.
 * Handles the types commonly used in tool parameters.
 */
function jsonSchemaToZod(schema: any, z: any): any {
  if (!schema) return z.object({});

  switch (schema.type) {
    case "object": {
      const shape: Record<string, any> = {};
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);

      for (const [key, prop] of Object.entries(properties)) {
        let field = jsonSchemaToZod(prop, z);
        if (!required.has(key)) {
          field = field.optional();
        }
        if ((prop as any).description) {
          field = field.describe((prop as any).description);
        }
        shape[key] = field;
      }
      return z.object(shape);
    }

    case "array":
      return z.array(jsonSchemaToZod(schema.items ?? {}, z));

    case "string": {
      let s = z.string();
      if (schema.enum) s = z.enum(schema.enum);
      return s;
    }

    case "number":
    case "integer":
      return z.number();

    case "boolean":
      return z.boolean();

    case "null":
      return z.null();

    default:
      return z.any();
  }
}
