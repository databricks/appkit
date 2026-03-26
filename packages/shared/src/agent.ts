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
// Adapter contract
// ---------------------------------------------------------------------------

export interface AgentInput {
  messages: Message[];
  tools: AgentToolDefinition[];
  threadId: string;
  signal?: AbortSignal;
}

export interface AgentRunContext {
  executeTool: (name: string, args: unknown) => Promise<unknown>;
  signal?: AbortSignal;
}

export interface AgentAdapter {
  run(
    input: AgentInput,
    context: AgentRunContext,
  ): AsyncGenerator<AgentEvent, void, unknown>;
}
