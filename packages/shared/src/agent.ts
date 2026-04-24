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
       * Emitted by the agents plugin (not adapters) when a tool call annotated
       * `destructive: true` is awaiting human approval. Clients should render
       * an approval prompt and POST to `/chat/approve` with the matching
       * `approvalId` and a `decision` of `approve` or `deny`.
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
 * Emitted when a destructive tool call is awaiting human approval. The client
 * should render an approval UI and POST the decision to `/chat/approve` with
 * `{ streamId, approvalId, decision: "approve" | "deny" }`. If no decision
 * arrives before the server-side timeout, the call is auto-denied and the
 * agent receives a denial string as the tool output.
 */
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
  | AppKitApprovalPendingEvent;

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface AgentInput {
  messages: Message[];
  tools: AgentToolDefinition[];
  threadId: string;
  signal?: AbortSignal;
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
}
