import type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  Message,
  ResponseStreamEvent,
} from "shared";

import {
  type ApiClientLike,
  type StreamBody,
  streamPath,
} from "../connectors/serving/client";
import { createLogger } from "../logging/logger";
import { readSseEvents } from "../stream";
import { createWorkspaceClient } from "../workspace-client";

const logger = createLogger("agents:supervisor-api");

/**
 * Total wall-clock budget for a single `run()` before the adapter aborts the
 * SSE stream and surfaces a terminal `transport` error. Guards against an
 * upstream that stalls indefinitely (the agent run path does not otherwise
 * wrap `adapter.run()` in a timeout). Override via
 * {@link SupervisorApiAdapterOptions.timeoutMs}.
 */
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;

/**
 * Stable client-facing error codes. We never surface raw upstream error
 * strings to the client (CWE-209) — the helper logs the verbose detail
 * server-side and returns one of these codes in the {@link AgentEvent}.
 */
type SupervisorErrorCode =
  | "transport"
  | "upstream_failed"
  | "upstream_tool"
  | "upstream_unknown";

/**
 * Single sink for all error events emitted by the adapter. Logs the verbose
 * detail (stack, upstream payload, etc.) at `warn` level and returns a
 * sanitised {@link AgentEvent} carrying only a stable code so the client
 * never sees raw upstream text.
 */
function emitError(code: SupervisorErrorCode, detail: unknown): AgentEvent {
  // Summarise at `warn` (CWE-532: never dump the full upstream payload to
  // the default log level); the verbose object is only available via
  // `DEBUG=appkit:agents:supervisor-api`.
  logger.warn(
    "supervisor-api error code=%s detail=%s",
    code,
    summariseErrorPayload(detail),
  );
  logger.debug("supervisor-api error code=%s detail=%O", code, detail);
  return {
    type: "status",
    status: "error",
    error: `Supervisor API error (${code})`,
  };
}

/**
 * Renders an upstream error / incomplete_details payload as a short
 * single-line string for log lines. Avoids dumping the full JSON tree
 * (CWE-532): we keep the discriminator (`type`/`code`) plus a trimmed
 * message, and that's it. Full payloads are still available via
 * `DEBUG=appkit:agents:supervisor-api`.
 */
function summariseErrorPayload(payload: unknown): string {
  if (payload == null) return "<none>";
  if (typeof payload === "string") {
    return payload.length > 80 ? `${payload.slice(0, 80)}…` : payload;
  }
  if (typeof payload !== "object") return String(payload);
  const obj = payload as Record<string, unknown>;
  const kind =
    (typeof obj.type === "string" && obj.type) ||
    (typeof obj.code === "string" && obj.code) ||
    (typeof obj.reason === "string" && obj.reason) ||
    "object";
  const message =
    (typeof obj.message === "string" && obj.message) ||
    (typeof obj.detail === "string" && obj.detail) ||
    "";
  const trimmed = message.length > 80 ? `${message.slice(0, 80)}…` : message;
  return trimmed ? `${kind}: ${trimmed}` : kind;
}

/**
 * Structural shape of a Databricks SDK client used by {@link fromSupervisorApi}.
 * Only what we need: `apiClient.request` for streaming and
 * `config.ensureResolved` to materialise the host/credentials.
 *
 * Exported because {@link SupervisorApiAdapterOptions.workspaceClient} (a
 * public type) references it — callers passing their own client can name
 * the shape they need to satisfy.
 */
export interface WorkspaceClientLike extends ApiClientLike {
  config: { ensureResolved(): Promise<void> };
}

// ---------------------------------------------------------------------------
// Supervisor API tool surface (wire format)
// ---------------------------------------------------------------------------

/**
 * Tools supported by the Databricks AI Gateway Responses API. The shapes match
 * the wire format the endpoint expects, so the adapter passes the array
 * straight into the request body.
 *
 * This is an adapter-internal wire type. Application code authors tools via
 * the {@link supervisorTools} factories, which return tagged
 * {@link HostedSupervisorTool} records — the agents plugin then unwraps
 * the `.spec` when routing through {@link AgentInput.extensions}.
 */
export type SupervisorTool =
  | { type: "genie_space"; genie_space: { id: string; description: string } }
  | { type: "uc_function"; uc_function: { name: string; description: string } }
  | {
      type: "knowledge_assistant";
      knowledge_assistant: {
        knowledge_assistant_id: string;
        description: string;
      };
    }
  | { type: "app"; app: { name: string; description: string } }
  | {
      type: "uc_connection";
      uc_connection: { name: string; description: string };
    };

/**
 * Tagged record returned by every {@link supervisorTools} factory. The
 * `__kind` discriminator lets the agents plugin (and standalone
 * `runAgent`) classify these tools without a structural match against the
 * wire format — keeps the SA wire shape free to evolve and avoids
 * namespace collisions with MCP hosted tools (which use `type: "genie-space"`
 * hyphenated, vs SA's `type: "genie_space"` underscored).
 */
export interface HostedSupervisorTool {
  readonly __kind: "hosted-supervisor";
  readonly spec: SupervisorTool;
}

/**
 * Type guard for {@link HostedSupervisorTool}. Used by the agents plugin
 * (`buildToolIndex`) and standalone `runAgent` (`classifyTool`) to route
 * supervisor-hosted tools to the extensions payload rather than the
 * adapter's `tools` array.
 */
export function isSupervisorTool(
  value: unknown,
): value is HostedSupervisorTool {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__kind === "hosted-supervisor"
  );
}

/**
 * Concise factories for declaring Supervisor API tools.
 *
 * Each factory accepts a single named-options object: routing-critical
 * strings (`id`, `name`, `description`) get labels at the call site so
 * "we swapped the args and didn't notice for two weeks" bugs are
 * impossible.
 *
 * `description` is required: SA's protobuf validation rejects `null`/`""`,
 * AND the LLM running on SA reads this string to decide when to route to
 * the tool. Two genie spaces both labelled "Genie space" give the model
 * nothing to discriminate on, so callers always own the routing hint.
 *
 * ⚠ The `description` is read by the LLM at routing time — it is a
 * prompt-injection sink. Do **not** derive it from untrusted input (user
 * messages, request bodies, external systems). Treat it as application
 * configuration. (CWE-1427)
 *
 * @example
 * ```ts
 * import { createAgent } from "@databricks/appkit";
 * import {
 *   agents,
 *   DatabricksAdapter,
 *   supervisorTools,
 * } from "@databricks/appkit/beta";
 *
 * const assistant = createAgent({
 *   instructions: "You are a helpful assistant.",
 *   model: DatabricksAdapter.fromSupervisorApi({
 *     model: "databricks-claude-sonnet-4",
 *   }),
 *   tools: () => ({
 *     nyc: supervisorTools.genieSpace({
 *       id: "01ABCDEF12345678",
 *       description: "NYC taxi trip records and zones",
 *     }),
 *     add: supervisorTools.ucFunction({
 *       name: "main.default.add",
 *       description: "Adds two integers and returns the sum.",
 *     }),
 *   }),
 * });
 * ```
 */
export const supervisorTools = {
  genieSpace: ({
    id,
    description,
  }: {
    id: string;
    description: string;
  }): HostedSupervisorTool => ({
    __kind: "hosted-supervisor",
    spec: { type: "genie_space", genie_space: { id, description } },
  }),
  ucFunction: ({
    name,
    description,
  }: {
    name: string;
    description: string;
  }): HostedSupervisorTool => ({
    __kind: "hosted-supervisor",
    spec: { type: "uc_function", uc_function: { name, description } },
  }),
  knowledgeAssistant: ({
    knowledgeAssistantId,
    description,
  }: {
    knowledgeAssistantId: string;
    description: string;
  }): HostedSupervisorTool => ({
    __kind: "hosted-supervisor",
    spec: {
      type: "knowledge_assistant",
      knowledge_assistant: {
        knowledge_assistant_id: knowledgeAssistantId,
        description,
      },
    },
  }),
  app: ({
    name,
    description,
  }: {
    name: string;
    description: string;
  }): HostedSupervisorTool => ({
    __kind: "hosted-supervisor",
    spec: { type: "app", app: { name, description } },
  }),
  ucConnection: ({
    name,
    description,
  }: {
    name: string;
    description: string;
  }): HostedSupervisorTool => ({
    __kind: "hosted-supervisor",
    spec: { type: "uc_connection", uc_connection: { name, description } },
  }),
};

// ---------------------------------------------------------------------------
// AgentInput.extensions integration
// ---------------------------------------------------------------------------

/**
 * Namespace key under which the adapter reads its hosted-tool payload
 * from {@link AgentInput.extensions}. Exported so the agents plugin and
 * standalone `runAgent` (the producers) can write under the same key the
 * adapter reads.
 */
export const SUPERVISOR_EXTENSION_KEY = "databricks.supervisor" as const;

/**
 * Shape of the value at `AgentInput.extensions[SUPERVISOR_EXTENSION_KEY]`.
 * The agents plugin / `runAgent` build this from the tool index; advanced
 * callers invoking `adapter.run(...)` directly populate it themselves.
 */
export interface SupervisorExtension {
  hostedTools?: SupervisorTool[];
}

function readSupervisorExtension(input: AgentInput): SupervisorExtension {
  const raw = input.extensions?.[SUPERVISOR_EXTENSION_KEY];
  // Single cast at the boundary. The contract on `extensions` is opaque;
  // we trust the producer (agents plugin / runAgent / caller) to use the
  // shape declared here.
  if (!raw || typeof raw !== "object") return {};
  return raw as SupervisorExtension;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface SupervisorApiAdapterOptions {
  /**
   * Model identifier to pass in the request body
   * (e.g. "databricks-claude-sonnet-4").
   */
  model: string;
  /**
   * A WorkspaceClient (or structural equivalent) used for host resolution
   * and per-request authentication. When omitted, a `WorkspaceClient({})`
   * is created internally using the default SDK credential chain
   * (`DATABRICKS_HOST`, OAuth, PAT, etc.).
   *
   * ⚠ The `workspaceClient` is captured at construction and reused across
   * every request. Passing a per-request OBO (On-Behalf-Of) client here
   * would silently leak the first request's identity into all subsequent
   * requests served by this adapter instance. Use the default credential
   * chain or pass a service-principal client. (CWE-664)
   */
  workspaceClient?: WorkspaceClientLike;
  /**
   * Total wall-clock budget (ms) for a single `run()`. When the SSE stream
   * runs longer than this — e.g. an upstream that stalls without closing —
   * the adapter aborts it and emits a terminal `transport` error rather than
   * hanging the request indefinitely.
   *
   * This is a total-duration cap, not an idle cap. Defaults to 5 minutes,
   * generous enough for multi-tool server-side orchestration.
   */
  timeoutMs?: number;
}

interface SupervisorApiAdapterCtorOptions {
  streamBody: StreamBody;
  model: string;
  timeoutMs?: number;
}

/**
 * Adapter that calls the Databricks AI Gateway Responses API
 * (`/ai-gateway/mlflow/v1/responses`).
 *
 * Streams SSE events in the OpenAI Responses API wire format and maps them
 * to the AppKit `AgentEvent` protocol. Tool execution is handled
 * server-side, so the adapter ignores the agents-plugin tool index.
 *
 * Authentication is handled via the Databricks SDK credential chain — the
 * same mechanism used by `DatabricksAdapter.fromModelServing`. The transport
 * is injected via {@link SupervisorApiAdapterCtorOptions.streamBody}; the
 * {@link fromSupervisorApi} factory wires it through the SDK's
 * `apiClient.request({ raw: true })`.
 *
 * Set `DEBUG=appkit:agents:supervisor-api` to log the outbound request
 * shape (model, instructions length, input shape, tool count) and to be
 * notified when the recovery path engages (no incremental deltas, text
 * pulled from `response.completed.output[]`). The no-delta warning includes
 * a per-turn event-type histogram and the SA-reported status/error/
 * incomplete_details, so it's already actionable without DEBUG.
 *
 * Tools are not configured on the adapter. Declare them via
 * `createAgent({ tools: () => ({ key: supervisorTools.genieSpace({...}) }) })`
 * (or markdown frontmatter referencing an ambient `supervisorTools.*` entry);
 * the agents plugin / standalone `runAgent` aggregates hosted-supervisor
 * entries and routes them to the adapter via
 * `AgentInput.extensions[SUPERVISOR_EXTENSION_KEY]`. Advanced callers
 * invoking `adapter.run(...)` directly populate that key themselves.
 *
 * @example
 * ```ts
 * import { createApp, createAgent } from "@databricks/appkit";
 * import {
 *   agents,
 *   DatabricksAdapter,
 *   supervisorTools,
 * } from "@databricks/appkit/beta";
 *
 * await createApp({
 *   plugins: [
 *     agents({
 *       agents: {
 *         assistant: createAgent({
 *           instructions: "You are a helpful assistant.",
 *           model: DatabricksAdapter.fromSupervisorApi({
 *             model: "databricks-claude-sonnet-4",
 *           }),
 *           tools: () => ({
 *             nyc: supervisorTools.genieSpace({
 *               id: "01ABCDEF12345678",
 *               description: "NYC taxi trip records and zones",
 *             }),
 *           }),
 *         }),
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export class SupervisorApiAdapter implements AgentAdapter {
  private streamBody: StreamBody;
  private model: string;
  private timeoutMs: number;

  /**
   * Capability negotiation: the adapter reads its hosted-tool payload
   * from {@link AgentInput.extensions} under {@link SUPERVISOR_EXTENSION_KEY}.
   * The agents plugin uses this list to warn at registration when the tool
   * index produces extensions the adapter wouldn't consume.
   */
  readonly acceptsExtensions = [SUPERVISOR_EXTENSION_KEY] as const;

  /**
   * Capability negotiation: the adapter does not consume `input.tools`.
   * Tool execution is owned by the Databricks AI Gateway server-side, so
   * any function tools or local sub-agents declared on this agent would
   * be silently dropped — the agents plugin warns at registration when
   * that combination is detected.
   */
  readonly consumesInputTools = false;

  constructor(options: SupervisorApiAdapterCtorOptions) {
    this.streamBody = options.streamBody;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  }

  async *run(
    input: AgentInput,
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    if (context.signal?.aborted) return;

    yield { type: "status", status: "running" };

    const { instructions, input: payloadInput } = this.buildInput(
      input.messages,
    );
    const hostedTools = readSupervisorExtension(input).hostedTools ?? [];
    yield* this.streamResponse(
      instructions,
      payloadInput,
      hostedTools,
      context.signal,
    );
  }

  private async *streamResponse(
    instructions: string | undefined,
    input: ResponseInput,
    hostedTools: SupervisorTool[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      input,
      stream: true,
    };
    if (instructions) {
      body.instructions = instructions;
    }
    // SA's protobuf validation rejects `tools: []` and `tools: null`. Only
    // include the field when at least one tool is configured.
    if (hostedTools.length > 0) {
      body.tools = hostedTools;
    }

    logger.debug(
      "model=%s instructionsLen=%d inputType=%s tools=%d",
      this.model,
      instructions?.length ?? 0,
      typeof input === "string" ? "string" : `array[${input.length}]`,
      hostedTools.length,
    );

    // Compose a total-duration timeout with the consumer's abort signal. The
    // agent run path drives `run()` directly without a TimeoutInterceptor, so
    // without this the adapter would hang forever on a stalled upstream. We
    // hand the combined signal to the transport + reader, but keep checking
    // the consumer's `signal` separately: a consumer-initiated abort is a
    // clean stop, whereas a timeout is a failure that must surface an error.
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.streamBody(body, combinedSignal);
    } catch (err) {
      // Aborts surface as exceptions thrown by `fetch`/SDK transports when
      // the consumer cancels mid-request. Treat as a clean stop so consumers
      // don't see a contradictory terminal `error` after their own abort. A
      // timeout (consumer signal not aborted) falls through to `emitError`.
      if (signal?.aborted) return;
      yield emitError("transport", err);
      return;
    }

    let receivedAnyDelta = false;
    // Tracks `item_id`s we've already streamed text deltas for. Used by
    // `mapEvent` to fall back to the final item text on `output_item.done`
    // only when no incremental deltas streamed for that item — avoids
    // double-emitting text when SA does both delta and done.
    const streamedItemIds = new Set<string>();
    // Histogram of received event types — surfaced in the no-delta warning
    // so it's actionable without re-running with DEBUG.
    const eventCounts = new Map<string, number>();
    // Set to true once we've yielded a terminal `{status:"error"}` event so
    // the recovery / completion / no-delta-warning blocks below all bail
    // out — the consumer's already seen the terminal status, anything
    // further would contradict the protocol's terminal-event semantics.
    let terminated = false;
    // Diagnostic snapshot of the last `response.completed` event. SA stuffs
    // the final assistant message into `response.output[]` even when it
    // didn't emit any deltas (e.g. when a tool failed or the model produced
    // nothing). Keeping it lets us recover the text and surface useful
    // errors instead of a silent empty turn.
    let lastCompleted:
      | {
          status?: string;
          output?: Array<{
            type?: string;
            content?: Array<{ type?: string; text?: string }>;
          }>;
          error?: unknown;
          incomplete_details?: unknown;
        }
      | undefined;

    // `readSseEvents` throws on transport errors and on the DoS caps
    // (maxLineChars / maxBufferChars). Without this guard the rejection
    // propagates out of `run()` and tears down the request. Treat a
    // consumer-initiated abort as a clean stop; everything else becomes a
    // sanitised terminal `transport` error.
    try {
      for await (const { event, data } of readSseEvents(
        stream,
        combinedSignal,
      )) {
        if (data === "[DONE]") continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch (err) {
          logger.debug(
            "Failed to parse SSE data line: %s (%O)",
            data.slice(0, 200),
            err,
          );
          continue;
        }

        const eventType =
          event || (typeof parsed.type === "string" ? parsed.type : "");
        eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);

        // `response.completed` is held back until after the loop so we can
        // synthesise a `message_delta` from `response.output[]` when the
        // stream produced no incremental deltas (intermittent SA behaviour).
        // Emitting `complete` first would let UIs finalise the turn before the
        // recovered text arrives.
        if (eventType === "response.completed") {
          lastCompleted = parsed.response as typeof lastCompleted;
          continue;
        }

        const out = mapEvent(eventType, parsed, streamedItemIds);
        if (out) {
          if (out.type === "message_delta") receivedAnyDelta = true;
          yield out;
          if (out.type === "status" && out.status === "error") {
            terminated = true;
            break;
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      yield emitError("transport", err);
      return;
    }

    // Consumer-initiated abort: clean stop, no terminal error.
    if (signal?.aborted) return;

    // Timeout fired while reading (the reader may break cleanly rather than
    // throw, depending on where the abort lands), so check it explicitly.
    if (timeoutSignal.aborted) {
      yield emitError(
        "transport",
        `stream timed out after ${this.timeoutMs}ms`,
      );
      return;
    }

    if (eventCounts.size === 0) {
      // A stream that closes without a single event leaves the consumer
      // stuck in `running`. Surface a terminal `transport` error so the
      // turn ends.
      yield emitError("transport", "stream closed without events");
      return;
    }

    if (terminated) return;

    // Recovery path: no deltas streamed but SA finished — pull the assistant
    // text out of `response.completed.response.output[]`.
    if (!receivedAnyDelta) {
      const recovered = extractTextFromCompletedResponse(lastCompleted);
      if (recovered) {
        logger.debug(
          "Recovered %d chars from response.completed.output[]",
          recovered.length,
        );
        yield { type: "message_delta", content: recovered };
        receivedAnyDelta = true;
      }
    }

    if (eventCounts.has("response.completed")) {
      // SA sometimes signals a failed turn via `response.completed` with a
      // nested `status: "failed"` (or a populated `error`) rather than
      // emitting `response.failed`. Without this gate the adapter would
      // silently yield `complete` on a server-side failure.
      //
      // `incomplete_details` on its own is NOT fatal: a benign
      // `max_output_tokens` truncation populates it while still producing
      // usable partial output. In that case we fall through to `complete`
      // and let the recovered text above stand as the turn result.
      if (lastCompleted?.status === "failed" || lastCompleted?.error != null) {
        yield emitError("upstream_failed", {
          status: lastCompleted?.status,
          error: lastCompleted?.error,
          incomplete_details: lastCompleted?.incomplete_details,
        });
        return;
      }
      yield { type: "status", status: "complete" };
    }

    if (!receivedAnyDelta) {
      const histogram = [...eventCounts.entries()]
        .map(([t, n]) => `${t}=${n}`)
        .join(", ");
      logger.warn(
        "Supervisor API stream completed without any output_text deltas. " +
          "events={%s} completed.status=%s completed.error=%s completed.incomplete=%s",
        histogram,
        lastCompleted?.status ?? "<none>",
        summariseErrorPayload(lastCompleted?.error),
        summariseErrorPayload(lastCompleted?.incomplete_details),
      );
      logger.debug(
        "Supervisor API no-delta full payload: error=%O incomplete=%O",
        lastCompleted?.error,
        lastCompleted?.incomplete_details,
      );
    }
  }

  /**
   * Splits the agent's message list into a Responses-API payload. System
   * messages are concatenated (in order) into the top-level `instructions`
   * field; user/assistant turns become `input` (as a plain string for the
   * common single-user-turn case, otherwise as `{role,content}[]`). Tool-role
   * messages are skipped — SA owns its own tool history server-side, so
   * re-feeding our tool-result records would only confuse it.
   */
  private buildInput(messages: Message[]): {
    instructions: string | undefined;
    input: ResponseInput;
  } {
    const instructionsParts: string[] = [];
    const turns: Array<{
      role: "user" | "assistant" | "system";
      content: string;
    }> = [];

    for (const m of messages) {
      if (m.role === "system") instructionsParts.push(m.content);
      else if (m.role !== "tool")
        turns.push({ role: m.role, content: m.content });
    }

    const instructions = instructionsParts.length
      ? instructionsParts.join("\n\n")
      : undefined;

    if (turns.length === 1 && turns[0].role === "user") {
      return { instructions, input: turns[0].content };
    }
    return { instructions, input: turns };
  }
}

type ResponseInput =
  | string
  | Array<{ role: "user" | "assistant" | "system"; content: string }>;

/**
 * Pulls the final assistant text out of the `response` payload attached to a
 * `response.completed` event. SA always materialises the full response there,
 * so this is our last-resort recovery path when the stream produced neither
 * `output_text.delta` nor an actionable `output_item.done` (observed
 * intermittently with tool-enabled SA agents).
 */
function extractTextFromCompletedResponse(
  response:
    | {
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
      }
    | undefined,
): string {
  if (!response?.output) return "";
  let text = "";
  for (const item of response.output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text;
}

function mapEvent(
  eventType: string,
  data: Record<string, unknown>,
  streamedItemIds: Set<string>,
): AgentEvent | null {
  // The cast restricts the switch domain to the closed wire-event union
  // exported by `shared`, so typos in case clauses (e.g. `response.faled`)
  // become compile errors instead of silent string mismatches. Unknown
  // event names still fall through to `default` at runtime — we don't
  // require exhaustive matching since SA emits more lifecycle events
  // than we care to map.
  switch (eventType as ResponseStreamEvent["type"]) {
    case "response.output_text.delta": {
      const itemId =
        typeof data.item_id === "string" ? data.item_id : undefined;
      if (itemId) streamedItemIds.add(itemId);
      return {
        type: "message_delta",
        content: typeof data.delta === "string" ? data.delta : "",
      };
    }

    // `response.completed` is intentionally absent: `streamResponse` holds
    // it back so it can synthesise a delta from `response.output[]` when
    // the stream produced none, then emits `{status:"complete"}` itself.

    case "response.failed":
      return emitError("upstream_failed", data);

    case "error": {
      // Branch detail extraction so a missing `error` field doesn't surface
      // the JSON-stringified literal `'"Unknown error"'` (with quotes) in
      // server logs. The client never sees this string — `emitError`
      // sanitises it to a stable code.
      const detail =
        typeof data.error === "string"
          ? data.error
          : data.error == null
            ? "Unknown error"
            : data.error;
      return emitError("upstream_unknown", detail);
    }

    case "response.output_item.done": {
      const item = data.item as
        | {
            id?: string;
            type?: string;
            content?: Array<{ text?: string; type?: string }>;
          }
        | undefined;

      // SA's contract reserves `item.id === "error"` for tool failures, but
      // a 5-char identifier collision is too small a margin. Require either
      // an explicit `type === "error"` or pair the reserved id with a
      // non-message type (a normal assistant message uses `type: "message"`).
      if (
        item?.type === "error" ||
        (item?.id === "error" && item?.type !== "message")
      ) {
        return emitError("upstream_tool", item);
      }

      // Fallback: when SA produces a tool-driven response (e.g. Genie space),
      // it often omits `response.output_text.delta` events and only emits the
      // final assistant message via `output_item.done`. Surface that text as
      // a single delta so the UI sees the answer.
      if (
        item?.type === "message" &&
        item.id &&
        !streamedItemIds.has(item.id)
      ) {
        const text = (item.content ?? [])
          .map((c) => (c.type === "output_text" ? (c.text ?? "") : ""))
          .join("");
        if (text.length > 0) {
          streamedItemIds.add(item.id);
          return { type: "message_delta", content: text };
        }
      }
      return null;
    }

    // All other event types are intentionally ignored. Notable lifecycle
    // events we drop on the floor: `response.created`, `response.in_progress`,
    // `response.output_text.done`, `response.output_item.added`,
    // `response.content_part.added`, `response.content_part.done`.
    default:
      return null;
  }
}

/**
 * Creates an {@link AgentAdapter} backed by the Databricks AI Gateway
 * Responses API (`/ai-gateway/mlflow/v1/responses`).
 *
 * Uses the SDK's default credential chain for auth (reads DATABRICKS_HOST,
 * DATABRICKS_TOKEN, OAuth config, etc.). Tools are declared on the agent
 * (via `createAgent({ tools })`), not on this factory.
 *
 * Application code should prefer the
 * {@link DatabricksAdapter.fromSupervisorApi} static — it delegates here
 * and keeps a single `DatabricksAdapter.from*` autocomplete root for all
 * Databricks-backed adapters. This free function is the implementation
 * behind the static and remains exported for callers that want to import
 * it directly without pulling in {@link DatabricksAdapter}.
 *
 * @example
 * ```ts
 * import { createApp, createAgent } from "@databricks/appkit";
 * import {
 *   agents,
 *   DatabricksAdapter,
 *   supervisorTools,
 * } from "@databricks/appkit/beta";
 *
 * await createApp({
 *   plugins: [
 *     agents({
 *       agents: {
 *         assistant: createAgent({
 *           instructions: "You are a helpful assistant.",
 *           model: DatabricksAdapter.fromSupervisorApi({
 *             model: "databricks-claude-sonnet-4",
 *           }),
 *           tools: () => ({
 *             nyc: supervisorTools.genieSpace({
 *               id: "01ABCDEF12345678",
 *               description: "NYC taxi trip records and zones",
 *             }),
 *           }),
 *         }),
 *       },
 *     }),
 *   ],
 * });
 * ```
 *
 * @remarks
 * ⚠ When passing your own `workspaceClient`, see the warning on
 * {@link SupervisorApiAdapterOptions.workspaceClient} — the client is
 * captured once and reused, so per-request OBO clients would leak
 * identity across requests.
 *
 * @see {@link DatabricksAdapter.fromSupervisorApi} — the recommended
 * application-facing entry point.
 */
export async function fromSupervisorApi(
  options: SupervisorApiAdapterOptions,
): Promise<AgentAdapter> {
  let client = options.workspaceClient;
  if (!client) {
    // The wrapper's client provides everything `WorkspaceClientLike` needs
    // (`apiClient.request` + `config.ensureResolved`) but its
    // `apiClient.request` signature is narrower than our structural
    // `Record<string, unknown>` shape, so a direct assignment doesn't type.
    // The cast bridges the structural gap — same pattern the serving
    // connector uses for `ApiClientLike`.
    client = createWorkspaceClient() as unknown as WorkspaceClientLike;
  }

  await client.config.ensureResolved();

  // Capture the resolved client so the closure doesn't depend on the outer
  // `let` binding being reassigned later.
  const resolved = client;
  return new SupervisorApiAdapter({
    streamBody: (body, signal) =>
      streamPath(resolved, "/ai-gateway/mlflow/v1/responses", body, signal),
    model: options.model,
    timeoutMs: options.timeoutMs,
  });
}
