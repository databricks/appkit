import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
} from "shared";

interface DatabricksAdapterOptions {
  endpointUrl: string;
  authenticate: () => Promise<Record<string, string>>;
  maxSteps?: number;
  systemPrompt?: string;
  maxTokens?: number;
}

interface WorkspaceConfig {
  host?: string;
  authenticate(headers: Headers): Promise<void>;
  ensureResolved(): Promise<void>;
}

interface ServingEndpointOptions {
  workspaceClient: { config: WorkspaceConfig };
  endpointName: string;
  maxSteps?: number;
  systemPrompt?: string;
  maxTokens?: number;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface DeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Adapter that talks directly to Databricks Model Serving `/invocations` endpoint.
 *
 * No dependency on the Vercel AI SDK or LangChain. Uses raw `fetch()` to POST
 * OpenAI-compatible payloads and parses the SSE stream itself. Calls
 * `authenticate()` per-request so tokens are always fresh.
 *
 * Handles both structured `tool_calls` responses and text-based tool call
 * fallback parsing for models that output tool calls as text.
 *
 * @example Using the factory (recommended)
 * ```ts
 * import { DatabricksAdapter } from "@databricks/appkit/agents/databricks";
 * import { WorkspaceClient } from "@databricks/sdk-experimental";
 *
 * const adapter = DatabricksAdapter.fromServingEndpoint({
 *   workspaceClient: new WorkspaceClient({}),
 *   endpointName: "my-endpoint",
 * });
 * appkit.agent.registerAgent("assistant", adapter);
 * ```
 *
 * @example Using the raw constructor
 * ```ts
 * const adapter = new DatabricksAdapter({
 *   endpointUrl: "https://host/serving-endpoints/my-endpoint/invocations",
 *   authenticate: async () => ({ Authorization: `Bearer ${token}` }),
 * });
 * ```
 */
export class DatabricksAdapter implements AgentAdapter {
  private url: string;
  private authenticate: () => Promise<Record<string, string>>;
  private maxSteps: number;
  private systemPrompt?: string;
  private maxTokens: number;

  constructor(options: DatabricksAdapterOptions) {
    this.url = options.endpointUrl;
    this.authenticate = options.authenticate;
    this.maxSteps = options.maxSteps ?? 10;
    this.systemPrompt = options.systemPrompt;
    this.maxTokens = options.maxTokens ?? 4096;
  }

  /**
   * Creates a DatabricksAdapter from a WorkspaceClient and endpoint name.
   * Resolves the config once to get the host, then authenticates per-request.
   */
  static async fromServingEndpoint(
    options: ServingEndpointOptions,
  ): Promise<DatabricksAdapter> {
    const { workspaceClient, endpointName, ...rest } = options;
    const config = workspaceClient.config;

    await config.ensureResolved();

    return new DatabricksAdapter({
      endpointUrl: `${config.host}/serving-endpoints/${endpointName}/invocations`,
      authenticate: async () => {
        const headers = new Headers();
        await config.authenticate(headers);
        return Object.fromEntries(headers.entries());
      },
      ...rest,
    });
  }

  async *run(
    input: AgentInput,
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    // Databricks API requires tool names to match [a-zA-Z0-9_-].
    // Our tool names use dots (e.g. "analytics.query"), so we swap dots
    // for double-underscores in the wire format and map back on receipt.
    const nameToWire = new Map<string, string>();
    const wireToName = new Map<string, string>();
    for (const tool of input.tools) {
      const wire = tool.name.replace(/\./g, "__");
      nameToWire.set(tool.name, wire);
      wireToName.set(wire, tool.name);
    }

    const tools = this.buildTools(input.tools, nameToWire);
    const messages = this.buildMessages(input.messages);

    if (this.systemPrompt) {
      messages.unshift({ role: "system", content: this.systemPrompt });
    }

    yield { type: "status", status: "running" };

    for (let step = 0; step < this.maxSteps; step++) {
      if (context.signal?.aborted) break;

      const { text, toolCalls } = yield* this.streamCompletion(
        messages,
        tools,
        context,
      );

      if (toolCalls.length === 0) {
        const parsed = parseTextToolCalls(text);
        if (parsed.length > 0) {
          yield* this.executeToolCalls(parsed, messages, context);
          continue;
        }
        break;
      }

      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const wireName = tc.function.name;
        const originalName = wireToName.get(wireName) ?? wireName;
        let args: unknown;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        yield { type: "tool_call", callId: tc.id, name: originalName, args };

        try {
          const result = await context.executeTool(originalName, args);
          const resultStr =
            typeof result === "string" ? result : JSON.stringify(result);

          yield { type: "tool_result", callId: tc.id, result };

          messages.push({
            role: "tool",
            content: resultStr,
            tool_call_id: tc.id,
          });
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : "Tool execution failed";

          yield {
            type: "tool_result",
            callId: tc.id,
            result: null,
            error: errMsg,
          };

          messages.push({
            role: "tool",
            content: JSON.stringify({ error: errMsg }),
            tool_call_id: tc.id,
          });
        }
      }
    }
  }

  private async *streamCompletion(
    messages: OpenAIMessage[],
    tools: OpenAITool[],
    context: AgentRunContext,
  ): AsyncGenerator<
    AgentEvent,
    { text: string; toolCalls: OpenAIToolCall[] },
    unknown
  > {
    const body: Record<string, unknown> = {
      messages,
      stream: true,
      max_tokens: this.maxTokens,
    };

    if (tools.length > 0) {
      body.tools = tools;
    }

    const authHeaders = await this.authenticate();

    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
      signal: context.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Databricks API error (${response.status}): ${errorText}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      while (true) {
        if (context.signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullText += delta.content;
            yield { type: "message_delta" as const, content: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls as DeltaToolCall[]) {
              const existing = toolCallAccumulator.get(tc.index);
              if (existing) {
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              } else {
                toolCallAccumulator.set(tc.index, {
                  id: tc.id ?? `call_${tc.index}`,
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: OpenAIToolCall[] = Array.from(
      toolCallAccumulator.values(),
    ).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments || "{}" },
    }));

    return { text: fullText, toolCalls };
  }

  private async *executeToolCalls(
    calls: Array<{ name: string; args: unknown }>,
    messages: OpenAIMessage[],
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const toolCallObjs: OpenAIToolCall[] = calls.map((c, i) => ({
      id: `text_call_${i}`,
      type: "function" as const,
      function: {
        name: c.name,
        arguments: JSON.stringify(c.args),
      },
    }));

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCallObjs,
    });

    for (const tc of toolCallObjs) {
      const name = tc.function.name;
      let args: unknown;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      yield { type: "tool_call", callId: tc.id, name, args };

      try {
        const result = await context.executeTool(name, args);
        const resultStr =
          typeof result === "string" ? result : JSON.stringify(result);

        yield { type: "tool_result", callId: tc.id, result };

        messages.push({
          role: "tool",
          content: resultStr,
          tool_call_id: tc.id,
        });
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Tool execution failed";

        yield {
          type: "tool_result",
          callId: tc.id,
          result: null,
          error: errMsg,
        };

        messages.push({
          role: "tool",
          content: JSON.stringify({ error: errMsg }),
          tool_call_id: tc.id,
        });
      }
    }
  }

  private buildMessages(messages: AgentInput["messages"]): OpenAIMessage[] {
    return messages.map((m) => ({
      role: m.role as OpenAIMessage["role"],
      content: m.content,
    }));
  }

  private buildTools(
    definitions: AgentToolDefinition[],
    nameToWire: Map<string, string>,
  ): OpenAITool[] {
    return definitions.map((def) => ({
      type: "function" as const,
      function: {
        name: nameToWire.get(def.name) ?? def.name,
        description: def.description,
        parameters: def.parameters,
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Vercel AI SDK helper
// ---------------------------------------------------------------------------

/**
 * Creates a Vercel AI-compatible model backed by a Databricks Model Serving endpoint.
 *
 * Use with `VercelAIAdapter` to get the Vercel AI SDK ecosystem (useChat, etc.)
 * while targeting a Databricks `/invocations` endpoint.
 *
 * Handles URL rewriting (`/chat/completions` -> `/invocations`), per-request
 * auth refresh, and tool name sanitization (dots -> double-underscores).
 *
 * Requires the `ai` and `@ai-sdk/openai` packages as peer dependencies.
 *
 * @example
 * ```ts
 * import { createDatabricksModel } from "@databricks/appkit/agents/databricks";
 * import { VercelAIAdapter } from "@databricks/appkit/agents/vercel-ai";
 * import { WorkspaceClient } from "@databricks/sdk-experimental";
 *
 * const model = await createDatabricksModel({
 *   workspaceClient: new WorkspaceClient({}),
 *   endpointName: "my-endpoint",
 * });
 * appkit.agent.registerAgent("assistant", new VercelAIAdapter({ model }));
 * ```
 */
export async function createDatabricksModel(
  options: ServingEndpointOptions,
): Promise<any> {
  let createOpenAI: any;
  try {
    const mod = await import("@ai-sdk/openai");
    createOpenAI = mod.createOpenAI;
  } catch {
    throw new Error(
      "createDatabricksModel requires '@ai-sdk/openai' as a dependency. Install it with: npm install @ai-sdk/openai ai",
    );
  }

  const config = options.workspaceClient.config;
  await config.ensureResolved();

  const baseURL = `${config.host}/serving-endpoints/${options.endpointName}`;

  const provider = createOpenAI({
    baseURL,
    apiKey: "databricks",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const rewritten = String(url).replace(
        "/chat/completions",
        "/invocations",
      );

      const headers = new Headers(init?.headers);
      await config.authenticate(headers);

      let body = init?.body;
      if (typeof body === "string") {
        body = rewriteToolNamesOutbound(body);
      }

      const response = await globalThis.fetch(rewritten, {
        ...init,
        headers,
        body,
      });

      if (
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        return response;
      }

      const transformed = response.body.pipeThrough(
        createToolNameRewriteStream(),
      );

      return new Response(transformed, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });

  return provider(options.endpointName);
}

/**
 * Rewrites tool names in outbound request body (dots -> double-underscores).
 */
function rewriteToolNamesOutbound(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed.tools) {
      for (const tool of parsed.tools) {
        if (tool.function?.name) {
          tool.function.name = tool.function.name.replace(/\./g, "__");
        }
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Creates a TransformStream that rewrites tool names in SSE response chunks
 * (double-underscores -> dots).
 */
function createToolNameRewriteStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const rewritten = text.replace(
        /"name"\s*:\s*"([a-zA-Z0-9_-]+)"/g,
        (match, name: string) => {
          if (name.includes("__")) {
            return match.replace(name, name.replace(/__/g, "."));
          }
          return match;
        },
      );
      controller.enqueue(encoder.encode(rewritten));
    },
  });
}

// ---------------------------------------------------------------------------
// Text-based tool call parsing (fallback)
// ---------------------------------------------------------------------------

/**
 * Parses text-based tool calls from model output.
 *
 * Handles two formats:
 * 1. Llama native: `[{"name": "tool_name", "parameters": {"arg": "val"}}]`
 * 2. Python-style: `[tool_name(arg1='val1', arg2='val2')]`
 */
export function parseTextToolCalls(
  text: string,
): Array<{ name: string; args: unknown }> {
  const trimmed = text.trim();

  const jsonResult = tryParseLlamaJsonToolCalls(trimmed);
  if (jsonResult.length > 0) return jsonResult;

  const pyResult = tryParsePythonStyleToolCalls(trimmed);
  if (pyResult.length > 0) return pyResult;

  return [];
}

function tryParseLlamaJsonToolCalls(
  text: string,
): Array<{ name: string; args: unknown }> {
  const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item: any) =>
          typeof item === "object" &&
          item !== null &&
          typeof item.name === "string",
      )
      .map((item: any) => ({
        name: item.name,
        args: item.parameters ?? item.arguments ?? item.args ?? {},
      }));
  } catch {
    return [];
  }
}

function tryParsePythonStyleToolCalls(
  text: string,
): Array<{ name: string; args: unknown }> {
  const pattern = /\[?([a-zA-Z_][\w.]*)\(([^)]*)\)\]?/g;
  const results: Array<{ name: string; args: unknown }> = [];

  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    const argsStr = match[2];

    const args: Record<string, unknown> = {};
    const argPattern = /(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)"|(\S+))/g;
    for (const argMatch of argsStr.matchAll(argPattern)) {
      const key = argMatch[1];
      const value = argMatch[2] ?? argMatch[3] ?? argMatch[4];
      args[key] = value;
    }

    results.push({ name, args });
  }

  return results;
}
