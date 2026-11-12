/**
 * Genie agent mode answers with a Responses-style protocol: each turn is a
 * list of output items (reasoning, tool calls, assistant messages). These
 * helpers pick out the answer text and the reasoning. Queries and charts are
 * read from the message projection instead, as in chat mode.
 */
import type { GenieMessageResponse } from "./types";

/** The fields of an agent output item that AppKit reads. */
export interface GenieAgentItem {
  type: string;
  role?: string;
  name?: string;
  content?: Array<{ text?: string }>;
  metadata?: { message_id?: string };
}

/** One SSE event from `POST /api/2.0/genie/agents/{id}/responses`. */
export interface GenieAgentStreamEvent {
  type: string;
  response?: {
    id: string;
    conversation_id: string;
    error?: { message?: string };
  };
  item?: GenieAgentItem;
  message?: string;
}

/** The answer text and reasoning an agent produced for one message. */
export interface GenieAgentTurn {
  answer: string[];
  reasoning: string[];
}

// Agent tools mapped onto status names the chat UI already labels.
const TOOL_STATUS: Record<string, string> = {
  execute_sql: "EXECUTING_QUERY",
  generate_visualization: "GENERATING_VISUALIZATION",
};

export function newAgentTurn(): GenieAgentTurn {
  return { answer: [], reasoning: [] };
}

/** The chat-mode status for a tool call item, if AppKit knows the tool. */
export function agentToolStatus(item: GenieAgentItem): string | undefined {
  return item.type === "function_call" && item.name
    ? TOOL_STATUS[item.name]
    : undefined;
}

/**
 * Adds an item's text to the turn. Returns the text when the item is a
 * reasoning step, so a live stream can forward it.
 */
export function addAgentItem(
  turn: GenieAgentTurn,
  item: GenieAgentItem,
): string | undefined {
  const text = (item.content ?? [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n");
  if (!text) return undefined;
  if (item.type === "reasoning") {
    turn.reasoning.push(text);
    return text;
  }
  if (item.type === "message" && item.role === "assistant") {
    turn.answer.push(text);
  }
  return undefined;
}

/**
 * The message projection of an agent turn has its queries and charts but no
 * answer text. Add the answer as a text attachment, which is where chat mode
 * carries it, and the reasoning.
 */
export function withAgentTurn(
  message: GenieMessageResponse,
  turn: GenieAgentTurn | undefined,
): GenieMessageResponse {
  if (!turn) return message;
  const answer = turn.answer.join("\n\n");
  return {
    ...message,
    attachments: answer
      ? [...(message.attachments ?? []), { text: { content: answer } }]
      : message.attachments,
    reasoning: turn.reasoning,
  };
}
