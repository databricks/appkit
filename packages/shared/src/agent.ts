import type { JSONSchema7 } from "json-schema";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Semantic hint for what the tool does to the world. Drives both the
 * agents-plugin approval gate and the client's approval-card styling.
 *
 * - `read` — observes only; never needs approval.
 * - `write` — creates or appends new state (e.g. saving a new view). Approval
 *   required by default. Rendered as a low-severity "writes" card.
 * - `update` — mutates existing state in place (e.g. renaming, toggling).
 *   Approval required. Rendered as a medium-severity "updates" card.
 * - `destructive` — deletes or irreversibly mutates (e.g. dropping a view).
 *   Approval required. Rendered as a high-severity "destructive" card.
 *
 * Prefer this over the legacy `readOnly`/`destructive` booleans: it lets the
 * UI distinguish "captured a screenshot" from "deleted a dashboard", both of
 * which today are lumped under a single red "destructive" label.
 */
export type ToolEffect = "read" | "write" | "update" | "destructive";

export interface ToolAnnotations {
  /**
   * Preferred semantic label. When set, drives both the approval gate (fires
   * for `write`/`update`/`destructive`) and the approval-card styling.
   */
  effect?: ToolEffect;
  /**
   * @deprecated Prefer {@link effect}. Retained for backward compatibility
   * with tools authored against the original flags and for MCP interop.
   */
  readOnly?: boolean;
  /**
   * @deprecated Prefer {@link effect} with value `"destructive"`. Retained
   * so existing annotations continue to force the approval gate, and so
   * MCP-style consumers that only read `destructive` still see the hint.
   */
  destructive?: boolean;
  idempotent?: boolean;
  requiresUserContext?: boolean;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema7;
  annotations?: ToolAnnotations;
}

export interface ToolProvider {
  getAgentTools(): AgentToolDefinition[];
  executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Messages & threads
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  createdAt: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  /**
   * Vendor-opaque "thought signature" blob attached by Vertex AI / Gemini
   * 2.x models to every function call they emit. Resumed threads must
   * echo this back verbatim on the next request or Vertex rejects with
   * `INVALID_ARGUMENT: function call X is missing a thought_signature`.
   * Stored here so adapters can preserve it across persistence
   * boundaries. Non-Gemini endpoints leave this undefined.
   * See https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
   */
  thoughtSignature?: string;
}

export interface Thread {
  id: string;
  userId: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Thread store
// ---------------------------------------------------------------------------

export interface ThreadStore {
  create(userId: string): Promise<Thread>;
  get(threadId: string, userId: string): Promise<Thread | null>;
  list(userId: string): Promise<Thread[]>;
  addMessage(threadId: string, userId: string, message: Message): Promise<void>;
  delete(threadId: string, userId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Agent events (SSE protocol)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "message_delta"; content: string }
  | { type: "message"; content: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      result: unknown;
      error?: string;
    }
  | { type: "thinking"; content: string }
  | {
      type: "status";
      status: "running" | "waiting" | "complete" | "error";
      error?: string;
    }
  | { type: "metadata"; data: Record<string, unknown> }
  | {
      /**
       * Emitted by the agents plugin (not adapters) after the streamed text:
       * the parsed, schema-validated object. Wire event:
       * {@link AppKitStructuredOutputEvent}.
       */
      type: "structured_output";
      data: unknown;
    }
  | {
      /**
       * Emitted by the agents plugin (not adapters) when a mutating tool call
       * is awaiting human approval — fires for tools annotated with
       * `effect: "write" | "update" | "destructive"` (preferred) or the
       * legacy `destructive: true` boolean. Clients should render an approval
       * prompt and POST to `/api/agents/approve` with the matching `approvalId` and
       * a `decision` of `approve` or `deny`.
       */
      type: "approval_pending";
      approvalId: string;
      streamId: string;
      toolName: string;
      args: unknown;
      annotations?: ToolAnnotations;
    };

// ---------------------------------------------------------------------------
// Responses API types (OpenAI-compatible wire format for HTTP boundary)
// Self-contained — no openai package dependency.
// ---------------------------------------------------------------------------

export interface OutputTextContent {
  type: "output_text";
  text: string;
}

export interface ResponseOutputMessage {
  type: "message";
  id: string;
  status: "in_progress" | "completed";
  role: "assistant";
  content: OutputTextContent[];
}

export interface ResponseFunctionToolCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponseFunctionCallOutput {
  type: "function_call_output";
  id: string;
  call_id: string;
  output: string;
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseFunctionToolCall
  | ResponseFunctionCallOutput;

export interface ResponseOutputItemAddedEvent {
  type: "response.output_item.added";
  output_index: number;
  item: ResponseOutputItem;
  sequence_number: number;
}

export interface ResponseOutputItemDoneEvent {
  type: "response.output_item.done";
  output_index: number;
  item: ResponseOutputItem;
  sequence_number: number;
}

export interface ResponseTextDeltaEvent {
  type: "response.output_text.delta";
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
  sequence_number: number;
}

export interface ResponseCompletedEvent {
  type: "response.completed";
  sequence_number: number;
  response: Record<string, unknown>;
}

export interface ResponseErrorEvent {
  type: "error";
  error: string;
  sequence_number: number;
}

export interface ResponseFailedEvent {
  type: "response.failed";
  sequence_number: number;
}

export interface AppKitThinkingEvent {
  type: "appkit.thinking";
  content: string;
  sequence_number: number;
}

export interface AppKitMetadataEvent {
  type: "appkit.metadata";
  data: Record<string, unknown>;
  sequence_number: number;
}

/**
 * Emitted when a mutating tool call is awaiting human approval. Fires for
 * tools annotated with `effect: "write" | "update" | "destructive"`
 * (preferred) or the legacy `destructive: true` boolean. The client should
 * render an approval UI and POST the decision to `/api/agents/approve` with
 * `{ streamId, approvalId, decision: "approve" | "deny" }`. If no decision
 * arrives before the server-side timeout, the call is auto-denied and the
 * agent receives a denial string as the tool output.
 */
/**
 * Emitted once on `/chat`, after the streamed assistant text, when the agent
 * declared an `output` schema. `data` is the parsed, schema-validated object.
 * The `appkit.` prefix matches the other AppKit-injected wire events
 * (`appkit.thinking`, `appkit.metadata`); the equivalent non-streaming field
 * is `output_parsed`.
 */
export interface AppKitStructuredOutputEvent {
  type: "appkit.structured_output";
  data: unknown;
  sequence_number: number;
}

export interface AppKitApprovalPendingEvent {
  type: "appkit.approval_pending";
  approval_id: string;
  stream_id: string;
  tool_name: string;
  args: unknown;
  annotations?: ToolAnnotations;
  sequence_number: number;
}

export type ResponseStreamEvent =
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseTextDeltaEvent
  | ResponseCompletedEvent
  | ResponseErrorEvent
  | ResponseFailedEvent
  | AppKitThinkingEvent
  | AppKitMetadataEvent
  | AppKitStructuredOutputEvent
  | AppKitApprovalPendingEvent;

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface AgentInput {
  messages: Message[];
  tools: AgentToolDefinition[];
  threadId: string;
  signal?: AbortSignal;
  /**
   * JSON Schema to constrain a tool-free completion to, for adapters that
   * support server-side structured output (OpenAI-compatible `response_format`).
   * Adapters that can't ignore it — the structured-output resolver then falls
   * back to prompt + Zod validation. Already stripped of the top-level
   * `$schema` key by {@link toToolJSONSchema}.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * Adapter-specific opaque payloads, keyed by adapter namespace. The
   * shared contract intentionally does not enumerate keys — see each
   * adapter's docs for which keys it reads and the shape of each value.
   *
   * The agents plugin and standalone `runAgent` populate this from the
   * agent's tool index when entries declare an adapter-side spec (e.g.
   * Supervisor API hosted tools). Adapters that don't read extensions
   * should leave it untouched.
   */
  extensions?: Readonly<Record<string, unknown>>;
}

export interface AgentRunContext {
  /** Tool implementations should sanitize failure text — errors become `tool_result.error` and can flow back into the LLM transcript. */
  executeTool: (name: string, args: unknown) => Promise<unknown>;
  signal?: AbortSignal;
}

export interface AgentAdapter {
  run(
    input: AgentInput,
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown>;

  /**
   * Extension keys this adapter consumes from {@link AgentInput.extensions}.
   * The agents plugin (and standalone `runAgent`) warns at registration
   * if the tool index produces extensions whose keys aren't listed here.
   *
   * Adapters that don't read extensions can omit this field.
   */
  readonly acceptsExtensions?: readonly string[];

  /**
   * Whether the adapter consumes tools from `input.tools`. Defaults to
   * true. Adapters whose tool execution happens elsewhere (e.g. the
   * Supervisor API, where SA owns the tool loop server-side) declare
   * false; the agents plugin warns at registration if the agent declares
   * function tools or local sub-agents alongside such an adapter, since
   * those tools would never reach the model.
   */
  readonly consumesInputTools?: boolean;
}
