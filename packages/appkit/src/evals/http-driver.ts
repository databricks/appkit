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

/** Parse a single Responses-API SSE `data:` payload into the running totals. */
function applyEvent(
  event: Record<string, unknown>,
  state: {
    reply: string;
    toolCalls: string[];
    seen: Set<string>;
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
      | { type?: string; name?: string; call_id?: string }
      | undefined;
    if (item?.type === "function_call" && item.name) {
      const key = item.call_id ?? item.name;
      if (!state.seen.has(key)) {
        state.seen.add(key);
        state.toolCalls.push(item.name);
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
        return { reply: "", toolCalls: [], succeeded: false };
      }

      if (!res.ok || !res.body) {
        return {
          reply: "",
          toolCalls: [],
          succeeded: false,
          sessionId: threadId,
        };
      }

      const state = {
        reply: "",
        toolCalls: [] as string[],
        seen: new Set<string>(),
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

      return {
        reply: state.reply,
        toolCalls: state.toolCalls,
        succeeded: state.ok,
        sessionId: threadId,
        traceId: state.traceId,
      };
    },
  };
}
