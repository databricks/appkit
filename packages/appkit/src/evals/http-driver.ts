import type { DriveResult, EvalDriver } from "./types";

export interface HttpDriverOptions {
  /** Base URL of the running app, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Agent alias to target. Omit to use the app's default agent. */
  agent?: string;
  /** Extra request headers (e.g. auth for a deployed app). */
  headers?: Record<string, string>;
  /** Chat endpoint path. Defaults to `/api/agents/chat`. */
  path?: string;
  /** MLflow run id to link each turn's trace to (for evaluation runs). */
  mlflowRunId?: string;
}

/** A single captured tool call, deduped by `call_id ?? name`. */
type ToolCall = { name: string; args: Record<string, unknown> };

/** Parse a function-call `arguments` JSON string; `{}` on missing/invalid. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Parse a single Responses-API SSE `data:` payload into the running totals. */
function applyEvent(
  event: Record<string, unknown>,
  state: {
    reply: string;
    toolCalls: Map<string, ToolCall>;
    ok: boolean;
    traceId?: string;
  },
  setThread: (id: string) => void,
): void {
  const type = event.type;
  if (
    type === "response.output_text.delta" &&
    typeof event.delta === "string"
  ) {
    state.reply += event.delta;
    return;
  }
  if (
    type === "response.output_item.added" ||
    type === "response.output_item.done"
  ) {
    const item = event.item as
      | { type?: string; name?: string; call_id?: string; arguments?: string }
      | undefined;
    if (item?.type === "function_call" && item.name) {
      const key = item.call_id ?? item.name;
      const args = parseArgs(item.arguments);
      const existing = state.toolCalls.get(key);
      if (!existing) {
        state.toolCalls.set(key, { name: item.name, args });
      } else if (Object.keys(args).length > 0) {
        // The initial `added` event may carry empty args while the later
        // `done` carries the full arguments — keep the fuller set.
        existing.args = args;
      }
    }
    return;
  }
  if (type === "error" || type === "response.failed") {
    state.ok = false;
    return;
  }
  if (type === "appkit.metadata") {
    const data = event.data as
      | { threadId?: string; mlflowTraceId?: string }
      | undefined;
    if (data?.threadId) setThread(data.threadId);
    if (data?.mlflowTraceId) state.traceId = data.mlflowTraceId;
  }
}

/**
 * Drives an agent by POSTing to a running app's chat endpoint and parsing the
 * SSE response. Keeps the thread id across `send`s so multi-turn evals share a
 * conversation. Agent/stream errors surface as `succeeded: false` rather than
 * throwing, so `t.succeeded()` can assert on them.
 */
export function createHttpDriver(options: HttpDriverOptions): EvalDriver {
  const chatPath = options.path ?? "/api/agents/chat";
  let threadId: string | undefined;

  return {
    reset(): void {
      threadId = undefined;
    },
    async send(message: string): Promise<DriveResult> {
      let res: Response;
      try {
        res = await fetch(`${options.baseUrl}${chatPath}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body: JSON.stringify({
            message,
            ...(options.agent ? { agent: options.agent } : {}),
            ...(threadId ? { threadId } : {}),
            ...(options.mlflowRunId
              ? { mlflowRunId: options.mlflowRunId }
              : {}),
          }),
        });
      } catch {
        return {
          reply: "",
          toolCalls: [],
          toolCallDetails: [],
          succeeded: false,
        };
      }

      if (!res.ok || !res.body) {
        return {
          reply: "",
          toolCalls: [],
          toolCallDetails: [],
          succeeded: false,
          sessionId: threadId,
        };
      }

      const state = {
        reply: "",
        toolCalls: new Map<string, ToolCall>(),
        ok: true,
        traceId: undefined as string | undefined,
      };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;
            try {
              applyEvent(JSON.parse(data), state, (id) => {
                threadId = id;
              });
            } catch {
              // skip malformed event lines
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const toolCallDetails = [...state.toolCalls.values()];
      return {
        reply: state.reply,
        toolCalls: toolCallDetails.map((c) => c.name),
        toolCallDetails,
        succeeded: state.ok,
        sessionId: threadId,
        traceId: state.traceId,
      };
    },
  };
}
