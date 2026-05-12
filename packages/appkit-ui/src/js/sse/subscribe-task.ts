/**
 * `subscribeToTask` — typed client for the AppKit task SSE
 * bridge.
 *
 * The bridge has a fixed wire shape: `event: <name>` /
 * `data: <JSON.stringify(payload)>` / `id: <streamSeq>`. Each frame the
 * task body emits via `ctx.emit(name, payload)` becomes one SSE event
 * with that name. Three event names are reserved by the bridge:
 *
 *   - `ready`     → bridge handshake. Emits `{ idempotencyKey }`. Always
 *                   first.
 *   - `completed` → terminal success. Emits the task's return value.
 *                   Stream closes after.
 *   - `failed`    → terminal failure. Emits `{ message }`. Stream closes.
 *   - `cancelled` → terminal cancellation (cooperative `stop()` or
 *                   client disconnect). Stream closes.
 *
 * Heartbeats are SSE comments (`: hb\n\n`) and never surface as events.
 *
 * Usage:
 *
 * ```ts
 * type CountEvents = {
 *   tick: { value: number; total: number };
 *   recovered: { resumed_from: number };
 * };
 *
 * await subscribeToTask<CountEvents>({
 *   url: "/api/durable-example/run",
 *   payload: { runKey, n, sleepMs },
 *   signal: controller.signal,
 *   onReady: ({ idempotencyKey }) => setIK(idempotencyKey),
 *   onEvent: {
 *     tick: ({ value, total }) => setProgress({ value, total }),
 *     recovered: ({ resumed_from }) => log(`resumed at ${resumed_from}`),
 *   },
 *   onCompleted: (result) => log("done", result),
 *   onFailed: (msg) => log("failed", msg),
 * });
 * ```
 */

import type { SSEMessage } from "./types";

/**
 * HTTP response header carrying the engine-derived idempotency key.
 *
 * **Duplicated on purpose** with the server-side definition in
 * `@databricks/appkit` (`packages/appkit/src/tasks/execute-task.ts`).
 * `appkit-ui` is a separate npm package (browser/runtime) and cannot
 * pull a constant from `appkit` (Node-only, would drag the entire
 * server bundle into the browser). The two MUST stay in lockstep —
 * change one, change the other. There is a contract test in
 * `subscribe-task.test.ts` that asserts the literal string.
 */
export const TASK_IDEMPOTENCY_HEADER = "X-AppKit-Task-Idempotency-Key";

/**
 * Per-event handler map. Each key is an event name from `TEvents`; the
 * value is a callback receiving the decoded payload. Handlers may
 * return `void` or a `Promise<void>` — the subscriber awaits each one
 * sequentially so the UI stays in sync with the wire order.
 *
 * **Constraint asymmetry note (deliberate):** the server-side `TEvents`
 * generic on `TaskDefinition` extends `Record<string, unknown>` (the
 * engine writes the payload into the WAL as JSON; an indexable object
 * is the cheapest way to type that). The client side here has no
 * `extends` constraint so callers can pass an `interface CountEvents
 * { tick: ...; recovered: ...; }` directly — interfaces don't have
 * implicit string index signatures, so requiring `extends Record`
 * would force `type` aliases everywhere. Both sides interoperate
 * through the wire payload, which is structurally compatible with
 * either constraint.
 */
export type TaskEventHandlers<TEvents> = {
  [K in keyof TEvents]?: (payload: TEvents[K]) => void | Promise<void>;
};

export interface SubscribeToTaskOptions<
  TEvents = Record<string, unknown>,
  TResult = unknown,
> {
  /** SSE endpoint — the same route the bridge writes to. */
  url: string;
  /**
   * Optional request body. When set, the helper issues `POST` with
   * `Content-Type: application/json`; otherwise `GET`. Use `GET` for
   * reattach routes that resolve a stream by URL parameter.
   */
  payload?: unknown;
  /** Optional headers; merged with the helper's defaults. */
  headers?: HeadersInit;
  /**
   * Last seen `id:` to resume from on a reconnect. Sent as
   * `Last-Event-ID`. The bridge maps it to the engine's
   * `streamSeq`, which the WAL uses to replay any frames the client
   * missed.
   */
  lastEventId?: string;
  /** Abort signal to cancel the underlying fetch. */
  signal?: AbortSignal;
  /**
   * Called once with the engine-derived idempotency key. Surfaced
   * twice by the bridge: as the `X-AppKit-Task-Idempotency-Key` response
   * header (read first if same-origin), and as the `ready` SSE event
   * (read by EventSource clients that can't see headers).
   */
  onReady?: (info: { idempotencyKey: string }) => void;
  /** Per-event handlers, typed by the `TEvents` map. */
  onEvent?: TaskEventHandlers<TEvents>;
  /**
   * Terminal success. Receives the task's return value; the parser
   * never throws if the payload doesn't match `TResult`.
   */
  onCompleted?: (result: TResult) => void;
  /** Terminal failure. Receives the error message produced by the bridge. */
  onFailed?: (message: string) => void;
  /** Terminal cancellation (cooperative `stop()` or client disconnect). */
  onCancelled?: () => void;
  /**
   * Network or parsing error. Not called when the abort signal fires —
   * an explicit cancel is not an error.
   */
  onError?: (error: unknown) => void;
  /**
   * Maximum buffered SSE bytes before the helper aborts with an
   * error. Defaults to 1MB.
   */
  maxBufferSize?: number;
}

export interface SubscribeToTaskResult {
  /**
   * The idempotency key surfaced by the bridge — either via the
   * `X-AppKit-Task-Idempotency-Key` response header (preferred) or the
   * first `ready` event. `null` if the stream ended before the bridge
   * sent either, e.g. because the request errored before headers
   * flushed.
   */
  idempotencyKey: string | null;
}

/**
 * Subscribes to a task SSE stream. Returns when the stream
 * ends (terminal event, abort, or network close).
 */
export async function subscribeToTask<
  TEvents = Record<string, unknown>,
  TResult = unknown,
>(
  options: SubscribeToTaskOptions<TEvents, TResult>,
): Promise<SubscribeToTaskResult> {
  const {
    url,
    payload,
    headers: extraHeaders,
    lastEventId,
    signal,
    onReady,
    onEvent,
    onCompleted,
    onFailed,
    onCancelled,
    onError,
    maxBufferSize = 1024 * 1024,
  } = options;

  if (!url || url.trim().length === 0) {
    throw new Error(
      "subscribeToTask: 'url' must be a non-empty string",
    );
  }

  const hasPayload = typeof payload !== "undefined";
  const baseHeaders: Record<string, string> = {
    Accept: "text/event-stream",
  };
  if (hasPayload) baseHeaders["Content-Type"] = "application/json";
  if (lastEventId) baseHeaders["Last-Event-ID"] = lastEventId;

  const headers = mergeHeaders(baseHeaders, extraHeaders);

  let idempotencyKey: string | null = null;
  let readyEmitted = false;

  // The consumer's `onReady` runs at most once with the consolidated
  // IK. The header is the source of truth (the bridge always sets it
  // before flushing the body); the `ready` event is a fallback for
  // EventSource clients that can't read response headers and for
  // cross-origin requests where the browser hides custom headers.
  const emitReady = (ikFromBody?: string) => {
    if (readyEmitted) return;
    if (!idempotencyKey && ikFromBody) idempotencyKey = ikFromBody;
    if (!idempotencyKey) return;
    readyEmitted = true;
    onReady?.({ idempotencyKey });
  };

  const result: SubscribeToTaskResult = {
    get idempotencyKey() {
      return idempotencyKey;
    },
  };

  try {
    const response = await fetch(url, {
      method: hasPayload ? "POST" : "GET",
      headers,
      body: hasPayload ? JSON.stringify(payload) : undefined,
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("No response body");
    }

    const headerIK = response.headers.get(TASK_IDEMPOTENCY_HEADER);
    if (headerIK) {
      idempotencyKey = headerIK;
      emitReady();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const decoded = decoder.decode(value, { stream: true });
      if (buffer.length + decoded.length > maxBufferSize) {
        throw new Error("subscribeToTask: buffer size exceeded");
      }
      buffer += decoded;

      const normalized = buffer.replace(/\r\n/g, "\n");
      const parts = normalized.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const message = parseSseFrame(part);
        if (!message) continue;

        const { stop } = await dispatchMessage<TEvents, TResult>(message, {
          onReady: (info) => emitReady(info.idempotencyKey),
          onEvent,
          onCompleted,
          onFailed,
          onCancelled,
        });

        if (stop) {
          // Terminal event seen — stop reading. The server will close
          // the underlying stream as well, but bailing here releases
          // the reader immediately so the caller can move on.
          await reader.cancel().catch(() => {});
          return result;
        }
      }
    }

    return result;
  } catch (error) {
    if (signal?.aborted) {
      // Explicit cancel from the caller — not an error path.
      return result;
    }
    onError?.(error);
    return result;
  }
}

// ── internals ──────────────────────────────────────────────────────────

interface DispatchHandlers<TEvents, TResult> {
  onReady?: (info: { idempotencyKey: string }) => void;
  onEvent?: TaskEventHandlers<TEvents>;
  onCompleted?: (result: TResult) => void;
  onFailed?: (message: string) => void;
  onCancelled?: () => void;
}

async function dispatchMessage<TEvents, TResult>(
  message: SSEMessage,
  handlers: DispatchHandlers<TEvents, TResult>,
): Promise<{ stop: boolean }> {
  const eventName = message.event || "message";
  const payload = parseJson(message.data);

  if (eventName === "ready") {
    if (payload && typeof payload === "object" && "idempotencyKey" in payload) {
      handlers.onReady?.({
        idempotencyKey: String(
          (payload as { idempotencyKey: unknown }).idempotencyKey,
        ),
      });
    }
    return { stop: false };
  }

  if (eventName === "completed") {
    handlers.onCompleted?.(payload as TResult);
    return { stop: true };
  }

  if (eventName === "failed" || eventName === "error") {
    const msg =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : eventName;
    handlers.onFailed?.(msg);
    return { stop: true };
  }

  if (eventName === "cancelled") {
    handlers.onCancelled?.();
    return { stop: true };
  }

  // Custom event from `ctx.emit(name, payload)`. The handler map is
  // optional per name — frames the consumer doesn't subscribe to are
  // silently dropped (matches the at-most-once-per-handler shape).
  const handler = handlers.onEvent?.[eventName as keyof TEvents] as
    | ((p: unknown) => void | Promise<void>)
    | undefined;
  if (handler) await handler(payload);

  return { stop: false };
}

/**
 * Parses one SSE chunk. Mirrors the parser used by `connectSSE` so the
 * two helpers stay aligned on field handling (id, event, data, comment
 * lines).
 */
function parseSseFrame(chunk: string): SSEMessage | null {
  const lines = chunk.replace(/\r\n/g, "\n").split("\n");

  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith(":")) continue;

    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("data:"))
      dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;
  return {
    id: id ?? "",
    event: event ?? "",
    data: dataLines.join("\n"),
  };
}

function parseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mergeHeaders(
  base: Record<string, string>,
  extra: HeadersInit | undefined,
): HeadersInit {
  if (!extra) return base;
  const out: Record<string, string> = { ...base };
  if (extra instanceof Headers) {
    extra.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(extra)) {
    for (const [k, v] of extra) out[k] = v;
  } else {
    Object.assign(out, extra);
  }
  return out;
}
