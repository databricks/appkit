import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
} from "shared";
import { stream as servingStream } from "../connectors/serving/client";

/**
 * Transport shim: given an OpenAI-compatible request body, returns the raw
 * SSE byte stream from the serving endpoint. Injected at construction time so
 * callers can swap in the workspace SDK (factory paths), a bare `fetch`
 * (the raw constructor), or a test fake.
 */
type StreamBody = (
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;

/**
 * Escape-hatch options: provide an `endpointUrl` + `authenticate()` and the
 * adapter uses a bare `fetch()` to call it. Useful for tests and for pointing
 * the adapter at non-workspace endpoints (reverse proxies, mocks).
 */
interface RawFetchAdapterOptions {
  endpointUrl: string;
  authenticate: () => Promise<Record<string, string>>;
  maxSteps?: number;
  maxTokens?: number;
}

/**
 * Preferred options: caller provides the transport function directly.
 * The `fromServingEndpoint` / `fromModelServing` factories use this to route
 * through `connectors/serving/stream`, which centralises URL encoding, auth
 * via the SDK's `apiClient.request`, and any future retries/telemetry.
 */
interface StreamBodyAdapterOptions {
  streamBody: StreamBody;
  maxSteps?: number;
  maxTokens?: number;
}

type DatabricksAdapterOptions =
  | RawFetchAdapterOptions
  | StreamBodyAdapterOptions;

function isStreamBodyOptions(
  o: DatabricksAdapterOptions,
): o is StreamBodyAdapterOptions {
  return "streamBody" in o;
}

/**
 * Duck-typed subset of the Databricks SDK `WorkspaceClient`. Callers of
 * `fromServingEndpoint` and `fromModelServing` pass a real `WorkspaceClient`,
 * but we only need the `apiClient.request` surface — so we declare the minimal
 * interface rather than importing the SDK type directly. This keeps the adapter
 * free of a hard compile-time dependency on `@databricks/sdk-experimental`.
 */
interface WorkspaceClientLike {
  apiClient: {
    request(options: Record<string, unknown>): Promise<unknown>;
  };
}

interface ServingEndpointOptions {
  workspaceClient: WorkspaceClientLike;
  endpointName: string;
  maxSteps?: number;
  maxTokens?: number;
}

interface ModelServingOptions {
  maxSteps?: number;
  maxTokens?: number;
  workspaceClient?: WorkspaceClientLike;
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
 * import { createApp, createAgent, agents } from "@databricks/appkit";
 * import { DatabricksAdapter } from "@databricks/appkit/agents/databricks";
 * import { WorkspaceClient } from "@databricks/sdk-experimental";
 *
 * const adapter = DatabricksAdapter.fromServingEndpoint({
 *   workspaceClient: new WorkspaceClient({}),
 *   endpointName: "my-endpoint",
 * });
 *
 * await createApp({
 *   plugins: [
 *     agents({
 *       agents: {
 *         assistant: createAgent({
 *           instructions: "You are a helpful assistant.",
 *           model: adapter,
 *         }),
 *       },
 *     }),
 *   ],
 * });
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
  private streamBody: StreamBody;
  private maxSteps: number;
  private maxTokens: number;

  constructor(options: DatabricksAdapterOptions) {
    this.maxSteps = options.maxSteps ?? 10;
    this.maxTokens = options.maxTokens ?? 4096;

    if (isStreamBodyOptions(options)) {
      this.streamBody = options.streamBody;
    } else {
      const { endpointUrl, authenticate } = options;
      this.streamBody = async (body, signal) => {
        const authHeaders = await authenticate();
        const response = await fetch(endpointUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          throw new Error(
            `Databricks API error (${response.status}): ${errorText}`,
          );
        }
        if (!response.body) throw new Error("No response body");
        return response.body;
      };
    }
  }

  /**
   * Creates a DatabricksAdapter for a Databricks Model Serving endpoint.
   *
   * Routes through the shared `connectors/serving/stream` helper, which
   * delegates to the SDK's `apiClient.request({ raw: true })`. That gives the
   * adapter centralised URL encoding + authentication with the rest of the
   * serving surface — no bespoke `fetch()` + `authenticate()` plumbing.
   */
  static async fromServingEndpoint(
    options: ServingEndpointOptions,
  ): Promise<DatabricksAdapter> {
    const { workspaceClient, endpointName, maxSteps, maxTokens } = options;
    return new DatabricksAdapter({
      streamBody: (body) =>
        // Cast through the structural shape: the connector types
        // `workspaceClient` as the SDK's concrete `WorkspaceClient`, but we
        // only need `apiClient.request`.
        servingStream(
          workspaceClient as unknown as Parameters<typeof servingStream>[0],
          endpointName,
          body,
        ),
      maxSteps,
      maxTokens,
    });
  }

  /**
   * Creates a DatabricksAdapter from a Model Serving endpoint name.
   * Auto-creates a WorkspaceClient internally. Reads the endpoint name
   * from the argument or the `DATABRICKS_AGENT_ENDPOINT` env var.
   *
   * @example
   * ```ts
   * // Reads endpoint from DATABRICKS_AGENT_ENDPOINT env var
   * const adapter = await DatabricksAdapter.fromModelServing();
   *
   * // Explicit endpoint
   * const adapter = await DatabricksAdapter.fromModelServing("my-endpoint");
   *
   * // With options
   * const adapter = await DatabricksAdapter.fromModelServing("my-endpoint", {
   *   maxSteps: 5,
   *   maxTokens: 2048,
   * });
   * ```
   */
  static async fromModelServing(
    endpointName?: string,
    options?: ModelServingOptions,
  ): Promise<DatabricksAdapter> {
    const resolvedEndpoint =
      endpointName ?? process.env.DATABRICKS_AGENT_ENDPOINT;

    if (!resolvedEndpoint) {
      throw new Error(
        "No endpoint name provided and DATABRICKS_AGENT_ENDPOINT env var is not set. " +
          "Pass an endpoint name or set the environment variable.",
      );
    }

    let workspaceClient: WorkspaceClientLike | undefined =
      options?.workspaceClient;
    if (!workspaceClient) {
      const sdk = await import("@databricks/sdk-experimental");
      workspaceClient = new sdk.WorkspaceClient(
        {},
      ) as unknown as WorkspaceClientLike;
    }

    return DatabricksAdapter.fromServingEndpoint({
      workspaceClient,
      endpointName: resolvedEndpoint,
      maxSteps: options?.maxSteps,
      maxTokens: options?.maxTokens,
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

    const responseBody = await this.streamBody(body, context.signal);
    const reader = responseBody.getReader();

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
