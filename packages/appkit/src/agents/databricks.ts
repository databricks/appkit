import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRemoteTraceEvent,
  AgentRunContext,
  AgentToolDefinition,
  AgentUsage,
} from "shared";
import {
  getResponseHeaders,
  retainResponseHeaders,
  type StreamBody,
  stream as servingStream,
} from "../connectors/serving/client";
import { APPKIT_USER_AGENT, getClientOptions } from "../context/client-options";
import { injectActiveTraceContext } from "../telemetry/agent-tracing";
import {
  DEFAULT_TRACE_REDACT_KEYS,
  REDACTED_TRACE_VALUE,
} from "../telemetry/agent-tracing/attributes";
import { createWorkspaceClient } from "../workspace-client";

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

const ERROR_SENSITIVE_KEY_PATTERN = new RegExp(
  `\\b(${[...DEFAULT_TRACE_REDACT_KEYS]
    .sort((left, right) => right.length - left.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|[^\\s,;&#]+)`,
  "gi",
);
const ERROR_AUTHORIZATION_PATTERN =
  /\b((?:proxy-)?authorization)\s*[:=]\s*(?:(?:Basic|Bearer)\s+)?[^\s,;]+/gi;
const ERROR_AUTH_SCHEME_PATTERN = /\b(Basic|Bearer)\s+[^\s,;]+/gi;
const ERROR_COOKIE_PATTERN = /\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi;
const ERROR_URL_PATTERN = /\bhttps?:\/\/[^\s]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNonNegativeNumber(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeUsage(
  parsed: Record<string, unknown>,
  previous: AgentUsage,
): AgentUsage | undefined {
  const raw = isRecord(parsed.usage) ? parsed.usage : undefined;
  const providerCost =
    finiteNonNegativeNumber(raw, "cost_usd", "cost", "total_cost_usd") ??
    finiteNonNegativeNumber(parsed, "cost_usd", "cost", "total_cost_usd");
  if (!raw) {
    if (providerCost === undefined) return undefined;
    return {
      ...previous,
      costUsd: providerCost,
      costAvailable: true,
    };
  }

  const inputTokens =
    finiteNonNegativeNumber(raw, "input_tokens", "prompt_tokens") ?? 0;
  const outputTokens =
    finiteNonNegativeNumber(raw, "output_tokens", "completion_tokens") ?? 0;
  const totalTokens =
    finiteNonNegativeNumber(raw, "total_tokens") ?? inputTokens + outputTokens;
  const details = isRecord(raw.input_tokens_details)
    ? raw.input_tokens_details
    : isRecord(raw.prompt_tokens_details)
      ? raw.prompt_tokens_details
      : undefined;
  const cacheReadInputTokens =
    finiteNonNegativeNumber(raw, "cache_read_input_tokens", "cached_tokens") ??
    finiteNonNegativeNumber(
      details,
      "cache_read_input_tokens",
      "cached_tokens",
    );
  const cacheCreationInputTokens =
    finiteNonNegativeNumber(raw, "cache_creation_input_tokens") ??
    finiteNonNegativeNumber(
      details,
      "cache_creation_input_tokens",
      "cache_creation_tokens",
    );
  const retainedCost =
    providerCost ?? (previous.costAvailable ? previous.costUsd : undefined);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens }
      : {}),
    ...(retainedCost !== undefined ? { costUsd: retainedCost } : {}),
    costAvailable: retainedCost !== undefined,
  };
}

function emptyUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costAvailable: false,
  };
}

function firstChoice(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const choices = parsed.choices;
  if (!Array.isArray(choices) || !isRecord(choices[0])) return undefined;
  return choices[0];
}

function remoteTraceFromPayload(
  parsed: Record<string, unknown>,
): AgentRemoteTraceEvent | undefined {
  const nested = isRecord(parsed.remote_trace)
    ? parsed.remote_trace
    : undefined;
  const traceIdCandidates = [
    nested?.trace_id,
    nested?.traceId,
    parsed.mlflow_trace_id,
    parsed.databricks_trace_id,
  ];
  const traceId = traceIdCandidates.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (!traceId) return undefined;

  const spanIdCandidates = [
    nested?.span_id,
    nested?.spanId,
    parsed.mlflow_span_id,
    parsed.databricks_span_id,
  ];
  const spanId = spanIdCandidates.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return spanId
    ? {
        type: "remote_trace",
        traceId,
        spanId,
        source: "model-serving",
        relation: "linked",
      }
    : {
        type: "remote_trace",
        traceId,
        source: "model-serving",
        relation: "continued",
      };
}

function sanitizedModelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Model request failed";
  const redacted = raw
    .replace(
      ERROR_COOKIE_PATTERN,
      (_match, key: string) => `${key}: ${REDACTED_TRACE_VALUE}`,
    )
    .replace(ERROR_URL_PATTERN, REDACTED_TRACE_VALUE)
    .replace(
      ERROR_AUTHORIZATION_PATTERN,
      (_match, key: string) => `${key}: ${REDACTED_TRACE_VALUE}`,
    )
    .replace(
      ERROR_AUTH_SCHEME_PATTERN,
      (_match, scheme: string) => `${scheme} ${REDACTED_TRACE_VALUE}`,
    )
    .replace(
      ERROR_SENSITIVE_KEY_PATTERN,
      (_match, key: string) => `${key}=${REDACTED_TRACE_VALUE}`,
    );
  const withoutControls = Array.from(redacted, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const singleLine = withoutControls.replace(/\s+/g, " ").trim();
  return (singleLine || "Model request failed").slice(0, 512);
}

function modelFromEndpointUrl(endpointUrl: string): string {
  try {
    const parts = new URL(endpointUrl).pathname.split("/");
    const endpointIndex = parts.indexOf("serving-endpoints");
    const encoded = parts[endpointIndex + 1];
    return encoded ? decodeURIComponent(encoded) : endpointUrl;
  } catch {
    return endpointUrl;
  }
}

/**
 * Optional generation parameters forwarded to the OpenAI-compatible serving
 * request body. Names match the serving API wire keys. Only keys that are set
 * are sent — undefined values are omitted so the endpoint applies its own
 * defaults. Ranges are not validated here; the serving endpoint validates.
 */
export interface GenerationParams {
  /** Sampling temperature. */
  temperature?: number;
  /** Nucleus sampling probability mass (`top_p`). */
  top_p?: number;
  /** Stop sequence(s) that end generation. */
  stop?: string | string[];
  /** Penalize tokens by frequency. */
  frequency_penalty?: number;
  /** Penalize tokens by prior presence. */
  presence_penalty?: number;
}

const GENERATION_PARAM_KEYS = [
  "temperature",
  "top_p",
  "stop",
  "frequency_penalty",
  "presence_penalty",
] as const satisfies readonly (keyof GenerationParams)[];

/** Copy only the set generation params onto the request body. */
function applyGenerationParams(
  body: Record<string, unknown>,
  params: GenerationParams,
): void {
  for (const key of GENERATION_PARAM_KEYS) {
    const value = params[key];
    if (value !== undefined) body[key] = value;
  }
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
  return firstChoice(parsed)?.delta;
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
 * Escape-hatch options: provide an `endpointUrl` + `authenticate()` and the
 * adapter uses a bare `fetch()` to call it. Useful for tests and for pointing
 * the adapter at non-workspace endpoints (reverse proxies, mocks).
 */
interface RawFetchAdapterOptions {
  endpointUrl: string;
  authenticate: () => Promise<Record<string, string>>;
  /** Model/endpoint name recorded in lifecycle telemetry. */
  model?: string;
  maxSteps?: number;
  maxTokens?: number;
  /** Optional generation params forwarded to the serving request body. */
  generationParams?: GenerationParams;
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
  /** Model/endpoint name recorded in lifecycle telemetry. */
  model?: string;
  maxSteps?: number;
  maxTokens?: number;
  generationParams?: GenerationParams;
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
  generationParams?: GenerationParams;
  maxSseLineChars?: number;
  maxStreamTextChars?: number;
  maxToolArgumentsChars?: number;
}

interface ModelServingOptions {
  maxSteps?: number;
  maxTokens?: number;
  generationParams?: GenerationParams;
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
  /**
   * Opaque Vertex/Gemini "thought signature" blob the request must echo
   * back verbatim on the next turn. Vertex's OpenAI-compat proxy emits
   * this as `thoughtSignature` (camelCase) at the top level of the
   * tool_call delta (verified against `gemini-3.1-flash-lite-preview`),
   * and accepts the same spelling back on outbound. Non-Gemini endpoints
   * (Claude on Databricks, external OpenAI-compat models, Llama, etc.)
   * leave this undefined and the serializer omits the key.
   * See https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
   */
  thoughtSignature?: string;
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
  /** See {@link OpenAIToolCall.thoughtSignature}. */
  thoughtSignature?: string;
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
 * import { createApp, createAgent, agents, createWorkspaceClient } from "@databricks/appkit";
 * import { DatabricksAdapter } from "@databricks/appkit/beta";
 *
 * const adapter = DatabricksAdapter.fromServingEndpoint({
 *   workspaceClient: createWorkspaceClient(),
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
  private model: string;
  private maxSteps: number;
  private maxTokens: number;
  private generationParams: GenerationParams;
  private maxSseLineChars: number;
  private maxStreamTextChars: number;
  private maxToolArgumentsChars: number;

  constructor(options: DatabricksAdapterOptions) {
    this.maxSteps = options.maxSteps ?? 10;
    this.maxTokens = options.maxTokens ?? 4096;
    this.generationParams = options.generationParams ?? {};
    this.maxSseLineChars =
      options.maxSseLineChars ?? DEFAULT_MAX_SSE_LINE_CHARS;
    this.maxStreamTextChars =
      options.maxStreamTextChars ?? DEFAULT_MAX_STREAM_TEXT_CHARS;
    this.maxToolArgumentsChars =
      options.maxToolArgumentsChars ?? DEFAULT_MAX_TOOL_ARGUMENT_CHARS;

    if (isStreamBodyOptions(options)) {
      this.streamBody = options.streamBody;
      this.model = options.model ?? "databricks-model-serving";
    } else {
      const { endpointUrl, authenticate } = options;
      this.model = options.model ?? modelFromEndpointUrl(endpointUrl);
      this.streamBody = async (body, signal) => {
        const fetchSignal =
          signal ?? AbortSignal.timeout(RAW_FETCH_DEFAULT_TIMEOUT_MS);
        const authHeaders = await authenticate();
        const headers = injectActiveTraceContext(
          new Headers({
            "User-Agent": APPKIT_USER_AGENT,
            "Content-Type": "application/json",
            ...authHeaders,
          }),
        );
        const response = await fetch(endpointUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: fetchSignal,
        });
        if (!response.ok) {
          throw new Error(`Databricks API error (${response.status})`);
        }
        if (!response.body) throw new Error("No response body");
        return retainResponseHeaders(response.body, response.headers);
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
      generationParams,
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
      model: endpointName,
      maxSteps,
      maxTokens,
      generationParams,
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
      workspaceClient = createWorkspaceClient({
        clientOptions: getClientOptions(),
      }) as unknown as WorkspaceClientLike;
    }

    return DatabricksAdapter.fromServingEndpoint({
      workspaceClient,
      endpointName: resolvedEndpoint,
      maxSteps: options?.maxSteps,
      maxTokens: options?.maxTokens,
      generationParams: options?.generationParams,
      maxSseLineChars: options?.maxSseLineChars,
      maxStreamTextChars: options?.maxStreamTextChars,
      maxToolArgumentsChars: options?.maxToolArgumentsChars,
    });
  }

  /**
   * Discoverability shim for the Supervisor API adapter. Returns an
   * {@link AgentAdapter} (a `SupervisorApiAdapter` at runtime), NOT a
   * {@link DatabricksAdapter} — the two are separate classes (different
   * wire formats, different lifecycle). The return type is the
   * {@link AgentAdapter} interface so callers aren't bound to the concrete
   * class. Surfaced here so application developers see a single
   * `DatabricksAdapter.from*` autocomplete root.
   *
   * Dynamic-imports `./supervisor-api` to avoid forming a load-time cycle:
   * both files share `connectors/serving/client.ts`.
   *
   * @example
   * ```ts
   * import { DatabricksAdapter } from "@databricks/appkit/beta";
   *
   * const model = await DatabricksAdapter.fromSupervisorApi({
   *   model: "databricks-claude-sonnet-4-5",
   * });
   * ```
   */
  static async fromSupervisorApi(
    options: import("./supervisor-api").SupervisorApiAdapterOptions,
  ): Promise<AgentAdapter> {
    const { fromSupervisorApi } = await import("./supervisor-api");
    return fromSupervisorApi(options);
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

    applyGenerationParams(body, this.generationParams);

    if (tools.length > 0) {
      body.tools = tools;
    }

    const stepId = globalThis.crypto.randomUUID();
    const startedAt = Date.now();
    const startEvent: AgentEvent = {
      type: "model_start",
      stepId,
      model: this.model,
      provider: "databricks",
      input: structuredClone(body),
      startedAt,
    };

    let fullText = "";
    let finalUsage = emptyUsage();
    let finishReason: string | undefined;
    let firstTokenAt: number | undefined;
    let streamStartedAt: number | undefined;
    let modelError: string | undefined;
    let caughtError: unknown;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const toolCallAccumulator = new Map<
      number,
      {
        id: string;
        name: string;
        arguments: string;
        thoughtSignature?: string;
      }
    >();
    const emittedRemoteTraces = new Set<string>();
    const snapshotToolCalls = (
      normalizeCompletedArguments = false,
    ): OpenAIToolCall[] =>
      Array.from(toolCallAccumulator.values()).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments:
            normalizeCompletedArguments && tc.arguments === ""
              ? "{}"
              : tc.arguments,
        },
        ...(tc.thoughtSignature
          ? { thoughtSignature: tc.thoughtSignature }
          : {}),
      }));

    try {
      yield startEvent;
      const responseBody = await this.streamBody(body, context.signal);
      streamStartedAt = Date.now();
      const headerTraceId = getResponseHeaders(responseBody)?.get(
        "x-databricks-trace-id",
      );
      if (headerTraceId?.trim()) {
        emittedRemoteTraces.add(headerTraceId);
        yield {
          type: "remote_trace",
          traceId: headerTraceId,
          source: "model-serving",
          relation: "continued",
        };
      }

      reader = responseBody.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
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

          if (!isRecord(parsed)) continue;

          const usage = normalizeUsage(parsed, finalUsage);
          if (usage) finalUsage = usage;

          const choice = firstChoice(parsed);
          if (typeof choice?.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }

          const remoteTrace = remoteTraceFromPayload(parsed);
          if (remoteTrace) {
            const key = `${remoteTrace.traceId}:${remoteTrace.spanId ?? ""}`;
            if (!emittedRemoteTraces.has(key)) {
              emittedRemoteTraces.add(key);
              yield remoteTrace;
            }
          }

          const deltaUnknown = openAiChoicesDelta(parsed);
          if (!isRecord(deltaUnknown)) continue;

          const toolCallsRaw = deltaUnknown.tool_calls;
          if (
            firstTokenAt === undefined &&
            ((typeof deltaUnknown.content === "string" &&
              deltaUnknown.content.length > 0) ||
              (Array.isArray(toolCallsRaw) && toolCallsRaw.length > 0))
          ) {
            firstTokenAt = Date.now();
          }

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

          if (!Array.isArray(toolCallsRaw)) continue;

          for (const tc of toolCallsRaw) {
            if (!isStreamingDeltaToolCall(tc)) continue;
            const sig = tc.thoughtSignature;
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
              if (sig && !existing.thoughtSignature) {
                existing.thoughtSignature = sig;
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
                ...(sig ? { thoughtSignature: sig } : {}),
              });
            }
          }
        }
      }
      if (context.signal?.aborted && !finishReason) {
        finishReason = "cancelled";
      }
    } catch (err) {
      if (context.signal?.aborted) {
        finishReason ??= "cancelled";
      } else {
        modelError = sanitizedModelError(err);
        caughtError = err;
        yield { type: "status", status: "error", error: modelError };
      }
    } finally {
      if (reader) {
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

      const endedAt = Date.now();
      yield {
        type: "model_end",
        stepId,
        model: this.model,
        provider: "databricks",
        output: { text: fullText, toolCalls: snapshotToolCalls() },
        usage: finalUsage,
        ...(finishReason ? { finishReason } : {}),
        ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
        streamDurationMs:
          streamStartedAt === undefined
            ? 0
            : Math.max(0, endedAt - streamStartedAt),
        endedAt,
        ...(modelError ? { error: modelError } : {}),
      };
    }

    if (caughtError !== undefined) throw caughtError;

    return { text: fullText, toolCalls: snapshotToolCalls(true) };
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
          ...(tc.thoughtSignature
            ? { thoughtSignature: tc.thoughtSignature }
            : {}),
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
