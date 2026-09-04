import { readSseEvents } from "../stream/sse-reader";
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
  /**
   * Max wall-clock time for a single turn before it is abandoned as a failed
   * turn (`succeeded: false`). Without this a hung agent — a blocked tool, a
   * stalled model — never ends the SSE stream (heartbeats keep it alive), so
   * the read loop spins forever and wedges the whole sequential suite.
   * Defaults to 120s.
   */
  // ponytail: total per-turn cap; switch to an idle timeout if long legit turns get killed.
  timeoutMs?: number;
}

/** Mutable running totals accumulated while draining one turn's SSE stream. */
interface DriveState {
  reply: string;
  toolCalls: string[];
  seen: Set<string>;
  ok: boolean;
  traceId?: string;
}

/** Record a `function_call` output item once per call id (deduped). */
function recordToolCall(
  item: { type?: string; name?: string; call_id?: string } | undefined,
  state: DriveState,
): void {
  if (item?.type !== "function_call" || !item.name) return;
  const key = item.call_id ?? item.name;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  state.toolCalls.push(item.name);
}

/** Apply an `appkit.metadata` event's thread/trace ids. */
function applyMetadata(
  data: { threadId?: string; mlflowTraceId?: string } | undefined,
  state: DriveState,
  setThread: (id: string) => void,
): void {
  if (data?.threadId) setThread(data.threadId);
  if (data?.mlflowTraceId) state.traceId = data.mlflowTraceId;
}

/** Parse a single Responses-API SSE `data:` payload into the running totals. */
function applyEvent(
  event: Record<string, unknown>,
  state: DriveState,
  setThread: (id: string) => void,
): void {
  const type = event.type;
  if (type === "response.output_text.delta") {
    if (typeof event.delta === "string") state.reply += event.delta;
    return;
  }
  if (
    type === "response.output_item.added" ||
    type === "response.output_item.done"
  ) {
    const item = event.item as {
      type?: string;
      name?: string;
      call_id?: string;
      content?: Array<{ text?: string }>;
    };
    recordToolCall(item, state);
    // A terminal `message` item carries the full reply text and *replaces*
    // the accumulated deltas — the server emits no delta for a full message
    // (event-translator `handleFullMessage`), so a non-streaming adapter's
    // whole reply arrives only here. Guard on non-empty so a streaming turn's
    // trailing done event can't clobber the deltas with "".
    if (type === "response.output_item.done" && item.type === "message") {
      const text = (item.content ?? []).map((c) => c.text ?? "").join("");
      if (text) state.reply = text;
    }
    return;
  }
  if (type === "error" || type === "response.failed") {
    state.ok = false;
    return;
  }
  if (type === "appkit.metadata") {
    applyMetadata(
      event.data as { threadId?: string; mlflowTraceId?: string },
      state,
      setThread,
    );
  }
}

/** Build the chat request payload, including only the optional fields that are set. */
function buildRequestBody(
  message: string,
  options: HttpDriverOptions,
  threadId: string | undefined,
): string {
  return JSON.stringify({
    message,
    ...(options.agent ? { agent: options.agent } : {}),
    ...(threadId ? { threadId } : {}),
    ...(options.mlflowRunId ? { mlflowRunId: options.mlflowRunId } : {}),
  });
}

/**
 * Drives an agent by POSTing to a running app's chat endpoint and parsing the
 * SSE response. Keeps the thread id across `send`s so multi-turn evals share a
 * conversation. Agent/stream errors surface as `succeeded: false` rather than
 * throwing, so `t.succeeded()` can assert on them.
 */
export function createHttpDriver(options: HttpDriverOptions): EvalDriver {
  const chatPath = options.path ?? "/api/agents/chat";
  const timeoutMs = options.timeoutMs ?? 120_000;
  let threadId: string | undefined;

  return {
    reset(): void {
      threadId = undefined;
    },
    async send(message: string): Promise<DriveResult> {
      // Bounds connect + the entire read below. Passed to both the fetch and
      // the SSE reader: on expiry the reader is cancelled and the turn fails.
      const signal = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await fetch(`${options.baseUrl}${chatPath}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body: buildRequestBody(message, options, threadId),
          // A chat endpoint never needs a redirect; following one would replay
          // custom auth headers (`options.headers`) to the redirect target.
          // A 3xx becomes an opaque response (res.ok === false), handled as a
          // failed turn by the !res.ok guard below.
          redirect: "manual",
          signal,
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

      const state: DriveState = {
        reply: "",
        toolCalls: [],
        seen: new Set<string>(),
        ok: true,
      };
      const setThread = (id: string) => {
        threadId = id;
      };
      try {
        for await (const { event, data } of readSseEvents(res.body, signal)) {
          if (data === "[DONE]") continue;
          // A stream-level error frame (a thrown exception in the generator)
          // is framed as `event: error` with a payload that carries no `type`,
          // so the SSE event name — not the payload — is the real signal.
          if (event === "error") state.ok = false;
          try {
            applyEvent(
              JSON.parse(data) as Record<string, unknown>,
              state,
              setThread,
            );
          } catch {
            // skip malformed event payloads
          }
        }
      } catch {
        // mid-stream transport error or DoS-guard throw: a broken turn.
        state.ok = false;
      }
      // A timeout ends the iterator cleanly (reader cancel) rather than
      // throwing, so mark an aborted turn failed explicitly.
      if (signal.aborted) state.ok = false;

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
