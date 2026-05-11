import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
} from "shared";
import { stream as servingStream } from "../connectors/serving/client";

/** Default cap for a single incomplete SSE line tail (DoS guard). */
const DEFAULT_MAX_SSE_LINE_CHARS = 1024 * 1024;

/** Default cap for accumulated assistant text from `delta.content`. */
const DEFAULT_MAX_STREAM_TEXT_CHARS = 4 * 1024 * 1024;

/** Default cap for accumulated JSON arguments per streamed tool call index. */
const DEFAULT_MAX_TOOL_ARGUMENT_CHARS = 2 * 1024 * 1024;

/** Cap text length before running Python-style tool-call regex (ReDoS guard). */
const PYTHON_STYLE_TOOL_PARSE_MAX_INPUT = 64 * 1024;

/** Fallback HTTP timeout when the raw fetch adapter path receives no AbortSignal from the runner. */
const RAW_FETCH_DEFAULT_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractLlamaToolJsonSlice(text: string): string | undefined {
  const start = text.indexOf("[{");
  if (start < 0) return undefined;
  const endBracket = text.lastIndexOf("}]");
  if (endBracket < start) return undefined;
  return text.slice(start, endBracket + 2);
}

/** OpenAI SSE payload: `{ choices: [{ delta }] }`. */
function openAiChoicesDelta(parsed: unknown): unknown {
  if (!isRecord(parsed)) return undefined;
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length < 1) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  return first.delta;
}

function isStreamingDeltaToolCall(value: unknown): value is DeltaToolCall {
  if (!isRecord(value)) return false;
  return typeof value.index === "number";
}

function throwIfExceedsStreamLimit(
  label: string,
  currentLength: number,
  chunk: string,
  max: number,
): void {
  if (currentLength + chunk.length > max) {
    throw new Error(
      `DatabricksAdapter: ${label} exceeds configured limit (${max} UTF-16 code units)`,
    );
  }
}

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
  /** Max length of one SSE line (including an incomplete tail in the buffer). */
  maxSseLineChars?: number;
  /** Max total length of assistant `delta.content` across the stream. */
  maxStreamTextChars?: number;
  /** Max length of streamed `function.arguments` per tool call index. */
  maxToolArgumentsChars?: number;
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
  maxSseLineChars?: number;
  maxStreamTextChars?: number;
  maxToolArgumentsChars?: number;
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
  maxSseLineChars?: number;
  maxStreamTextChars?: number;
  maxToolArgumentsChars?: number;
}

interface ModelServingOptions {
  maxSteps?: number;
  maxTokens?: number;
  workspaceClient?: WorkspaceClientLike;
  maxSseLineChars?: number;
  maxStreamTextChars?: number;
  maxToolArgumentsChars?: number;
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
 * import { DatabricksAdapter } from "@databricks/appkit/beta";
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
  private maxSseLineChars: number;
  private maxStreamTextChars: number;
  private maxToolArgumentsChars: number;

  constructor(options: DatabricksAdapterOptions) {
    this.maxSteps = options.maxSteps ?? 10;
    this.maxTokens = options.maxTokens ?? 4096;
    this.maxSseLineChars =
      options.maxSseLineChars ?? DEFAULT_MAX_SSE_LINE_CHARS;
    this.maxStreamTextChars =
      options.maxStreamTextChars ?? DEFAULT_MAX_STREAM_TEXT_CHARS;
    this.maxToolArgumentsChars =
      options.maxToolArgumentsChars ?? DEFAULT_MAX_TOOL_ARGUMENT_CHARS;

    if (isStreamBodyOptions(options)) {
      this.streamBody = options.streamBody;
    } else {
      const { endpointUrl, authenticate } = options;
      this.streamBody = async (body, signal) => {
        const fetchSignal =
          signal ?? AbortSignal.timeout(RAW_FETCH_DEFAULT_TIMEOUT_MS);
        const authHeaders = await authenticate();
        const response = await fetch(endpointUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify(body),
          signal: fetchSignal,
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
    const {
      workspaceClient,
      endpointName,
      maxSteps,
      maxTokens,
      maxSseLineChars,
      maxStreamTextChars,
      maxToolArgumentsChars,
    } = options;
    return new DatabricksAdapter({
      streamBody: (body, signal) =>
        // Cast through the structural shape: the connector types
        // `workspaceClient` as the SDK's concrete `WorkspaceClient`, but we
        // only need `apiClient.request`.
        servingStream(
          workspaceClient as unknown as Parameters<typeof servingStream>[0],
          endpointName,
          body,
          signal,
        ),
      maxSteps,
      maxTokens,
      maxSseLineChars,
      maxStreamTextChars,
      maxToolArgumentsChars,
    });
  }

  /**
   * Creates a DatabricksAdapter from a Model Serving endpoint name.
   * Auto-creates a WorkspaceClient internally. Reads the endpoint name
   * from the argument or the `DATABRICKS_SERVING_ENDPOINT_NAME` env var.
   *
   * @example
   * ```ts
   * // Reads endpoint from DATABRICKS_SERVING_ENDPOINT_NAME env var
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
      endpointName ?? process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

    if (!resolvedEndpoint) {
      throw new Error(
        "No endpoint name provided and DATABRICKS_SERVING_ENDPOINT_NAME env var is not set. " +
          "Pass an endpoint name or set DATABRICKS_SERVING_ENDPOINT_NAME.",
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
      maxSseLineChars: options?.maxSseLineChars,
      maxStreamTextChars: options?.maxStreamTextChars,
      maxToolArgumentsChars: options?.maxToolArgumentsChars,
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
      if (wireToName.has(wire) && wireToName.get(wire) !== tool.name) {
        throw new Error(
          `Tool name collision: '${tool.name}' and '${wireToName.get(wire)}' both map to wire name '${wire}'`,
        );
      }
      nameToWire.set(tool.name, wire);
      wireToName.set(wire, tool.name);
    }

    const tools = this.buildTools(input.tools, nameToWire);
    const messages = this.buildMessages(input.messages, nameToWire);

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
          yield* this.executeToolCalls(parsed, messages, context, nameToWire);
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
        yield* this.executeSingleTool(tc, originalName, messages, context);
      }
    }
  }

  /** Parse wire arguments, emit tool_call / tool_result, append tool messages. */
  private async *executeSingleTool(
    tc: OpenAIToolCall,
    originalName: string,
    messages: OpenAIMessage[],
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
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

    let responseBody: ReadableStream<Uint8Array>;
    try {
      responseBody = await this.streamBody(body, context.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stream request failed";
      yield { type: "status", status: "error", error: msg };
      throw err;
    }

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

        if (buffer.length > this.maxSseLineChars) {
          throw new Error(
            `DatabricksAdapter: SSE line buffer exceeds configured limit (${this.maxSseLineChars} UTF-16 code units)`,
          );
        }

        for (const line of lines) {
          if (line.length > this.maxSseLineChars) {
            throw new Error(
              `DatabricksAdapter: SSE line exceeds configured limit (${this.maxSseLineChars} UTF-16 code units)`,
            );
          }

          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch (parseErr) {
            console.debug(
              "[DatabricksAdapter] malformed SSE data line JSON",
              { line: `${data.slice(0, 256)}${data.length > 256 ? "…" : ""}` },
              parseErr,
            );
            continue;
          }

          const deltaUnknown = openAiChoicesDelta(parsed);
          if (!isRecord(deltaUnknown)) continue;

          if (typeof deltaUnknown.content === "string") {
            const content = deltaUnknown.content;
            throwIfExceedsStreamLimit(
              "streamed assistant text",
              fullText.length,
              content,
              this.maxStreamTextChars,
            );
            fullText += content;
            yield { type: "message_delta" as const, content };
          }

          const toolCallsRaw = deltaUnknown.tool_calls;
          if (!Array.isArray(toolCallsRaw)) continue;

          for (const tc of toolCallsRaw) {
            if (!isStreamingDeltaToolCall(tc)) continue;
            const existing = toolCallAccumulator.get(tc.index);
            if (existing) {
              if (tc.function?.arguments) {
                throwIfExceedsStreamLimit(
                  "tool call arguments",
                  existing.arguments.length,
                  tc.function.arguments,
                  this.maxToolArgumentsChars,
                );
                existing.arguments += tc.function.arguments;
              }
            } else {
              const initial = tc.function?.arguments ?? "";
              if (initial.length > this.maxToolArgumentsChars) {
                throw new Error(
                  `DatabricksAdapter: tool call arguments exceed configured limit (${this.maxToolArgumentsChars} UTF-16 code units)`,
                );
              }
              toolCallAccumulator.set(tc.index, {
                id: tc.id ?? `call_${tc.index}`,
                name: tc.function?.name ?? "",
                arguments: initial,
              });
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch (cancelErr) {
        console.debug(
          "[DatabricksAdapter] reader.cancel() failed during teardown",
          cancelErr,
        );
      }
      try {
        reader.releaseLock();
      } catch (unlockErr) {
        console.debug(
          "[DatabricksAdapter] reader.releaseLock() failed during teardown",
          unlockErr,
        );
      }
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
    nameToWire: Map<string, string>,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const wireToolName = (name: string) =>
      nameToWire.get(name) ?? name.replace(/\./g, "__");

    const toolCallObjs: OpenAIToolCall[] = calls.map((c, i) => ({
      id: `text_call_${i}`,
      type: "function" as const,
      function: {
        name: wireToolName(c.name),
        arguments: JSON.stringify(c.args),
      },
    }));

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCallObjs,
    });

    for (let i = 0; i < toolCallObjs.length; i++) {
      const tc = toolCallObjs[i];
      const originalName = calls[i]?.name ?? tc.function.name;
      yield* this.executeSingleTool(tc, originalName, messages, context);
    }
  }

  /**
   * Maps AppKit {@link AgentInput} messages into OpenAI-compatible wire messages.
   * Preserves multi-turn tool state (`toolCalls` → `tool_calls`, `toolCallId` →
   * `tool_call_id`) so resumed threads and hydrated history reach the model.
   */
  private buildMessages(
    messages: AgentInput["messages"],
    nameToWire: Map<string, string>,
  ): OpenAIMessage[] {
    const wireToolName = (name: string) =>
      nameToWire.get(name) ?? name.replace(/\./g, "__");

    return messages.map((m) => {
      let content: string | null = m.content;
      if (
        m.role === "assistant" &&
        m.toolCalls &&
        m.toolCalls.length > 0 &&
        (!m.content || m.content.trim() === "")
      ) {
        content = null;
      }

      const out: OpenAIMessage = {
        role: m.role as OpenAIMessage["role"],
        content,
      };

      if (m.toolCallId) {
        out.tool_call_id = m.toolCallId;
      }

      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: wireToolName(tc.name),
            arguments:
              typeof tc.args === "string"
                ? tc.args
                : JSON.stringify(tc.args ?? {}),
          },
        }));
      }

      return out;
    });
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

function isLlamaToolJsonItem(value: unknown): value is Record<
  string,
  unknown
> & {
  name: string;
} {
  if (!isRecord(value)) return false;
  return typeof value.name === "string";
}

function tryParseLlamaJsonToolCalls(
  text: string,
): Array<{ name: string; args: unknown }> {
  const slice = extractLlamaToolJsonSlice(text);
  if (!slice) return [];

  try {
    const parsed: unknown = JSON.parse(slice);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isLlamaToolJsonItem).map((item) => ({
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
  if (text.length > PYTHON_STYLE_TOOL_PARSE_MAX_INPUT) {
    return [];
  }

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
