import type { AgentInput } from "shared";

// ---------------------------------------------------------------------------
// OpenAI message types
// ---------------------------------------------------------------------------

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface DeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Converts AppKit messages to OpenAI-format messages, preserving
 * tool_calls on assistant messages and tool_call_id on tool results.
 */
export function buildOpenAIMessages(
  messages: AgentInput["messages"],
): OpenAIMessage[] {
  return messages.map((m) => {
    const msg: OpenAIMessage = {
      role: m.role as OpenAIMessage["role"],
      content: m.content,
    };
    if (m.toolCallId) {
      msg.tool_call_id = m.toolCallId;
    }
    if (m.toolCalls?.length) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments:
            typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
        },
      }));
    }
    return msg;
  });
}

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

/**
 * Async generator that reads an SSE stream and yields each parsed
 * JSON `data:` payload. Handles buffering, `[DONE]` sentinel, and
 * graceful abort via signal.
 */
export async function* parseSseStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<any, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;

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

        try {
          yield JSON.parse(data);
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
