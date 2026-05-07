import type { JSONSchema7 } from "json-schema";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  readOnly?: boolean;
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
  | { type: "metadata"; data: Record<string, unknown> };

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

export type ResponseStreamEvent =
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseTextDeltaEvent
  | ResponseCompletedEvent
  | ResponseErrorEvent
  | ResponseFailedEvent
  | AppKitThinkingEvent
  | AppKitMetadataEvent;

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
