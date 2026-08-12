/**
 * A single event observed on a stream. AppKit adapters yield objects with a
 * `type` discriminator; SSE frames parsed from an HTTP response carry the
 * event name under `event`. {@link expectStream} normalizes both to a type
 * string, preferring `type` and falling back to `event`.
 */
export interface StreamEvent {
  type?: string;
  event?: string;
  [key: string]: unknown;
}

/**
 * Anything {@link expectStream} can consume:
 * - an async event stream (an adapter's `run()`, an SSE reader),
 * - an already-collected array of events,
 * - an SSE `Response` (or a promise of one) — its body is parsed into events.
 */
export type StreamSource =
  | AsyncIterable<StreamEvent>
  | Iterable<StreamEvent>
  | Response
  | Promise<Response>;

/** Assertions over the events collected from a {@link StreamSource}. */
export interface StreamAssertion {
  /**
   * Assert that `eventTypes` appear, in this order, among the emitted event
   * types. Extra events (heartbeats, metadata, deltas) may appear before,
   * between, or after — this is an in-order subsequence match, which is what
   * you want for streams that interleave bookkeeping events. Resolves to the
   * full list of emitted types on success; rejects with a diff otherwise.
   */
  toEmit(...eventTypes: string[]): Promise<string[]>;
  /**
   * Assert that the emitted event types are exactly `eventTypes`, in order and
   * with nothing else. Use when the stream's shape is fully determined.
   */
  toEmitExactly(...eventTypes: string[]): Promise<string[]>;
  /** Collect and return the normalized events without asserting. */
  collect(): Promise<StreamEvent[]>;
  /** Collect and return just the event type strings, in order. */
  collectTypes(): Promise<string[]>;
}

function eventType(event: StreamEvent): string {
  return event.type ?? event.event ?? "";
}

/**
 * Parse a finished SSE response body into events. Blocks are delimited by a
 * blank line; within a block, `event:` sets the name and `data:` lines are
 * joined and JSON-parsed when possible. Comment/heartbeat lines (`:`) and
 * blocks without data are ignored.
 */
function parseSSEBody(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  // Normalize CRLF to LF first so frames delimited by `\r\n\r\n` (spec-compliant
  // SSE from a real server) split the same as AppKit's own `\n\n` writer.
  const blocks = text.replace(/\r\n/g, "\n").split("\n\n");

  for (const block of blocks) {
    let name: string | undefined;
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        name = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
      // `id:` and comment (`:`) lines carry no event type/data we assert on.
    }

    // A frame with no data line is bookkeeping (a bare `event:`, an `id:`, or a
    // `:` comment/heartbeat) that a real SSE client does not surface as an
    // event — skip it whether or not it carried an `event:` name.
    if (dataLines.length === 0) continue;

    const data = dataLines.join("\n");
    let parsed: Record<string, unknown> = {};
    if (data) {
      try {
        const json = JSON.parse(data);
        if (json && typeof json === "object" && !Array.isArray(json)) {
          parsed = json as Record<string, unknown>;
        } else {
          parsed = { data: json };
        }
      } catch {
        parsed = { data };
      }
    }

    // The wire `event:` name is authoritative. Spread the payload FIRST, then
    // set `type`, so a `data` payload that happens to carry its own `type`
    // field (e.g. `event: error` + `data: {"type":"result"}`) cannot override
    // the frame's real event name.
    events.push({
      ...parsed,
      type: name ?? (parsed.type as string | undefined),
    });
  }

  return events;
}

async function collectEventsInner(
  source: StreamSource,
): Promise<StreamEvent[]> {
  const resolved = await source;

  if (resolved instanceof Response) {
    const text = await resolved.text();
    return parseSSEBody(text);
  }

  if (resolved && typeof resolved === "object") {
    if (Symbol.asyncIterator in resolved) {
      const events: StreamEvent[] = [];
      for await (const event of resolved as AsyncIterable<StreamEvent>) {
        events.push(event);
      }
      return events;
    }
    if (Symbol.iterator in resolved) {
      return Array.from(resolved as Iterable<StreamEvent>);
    }
  }

  throw new Error(
    "expectStream: source must be an async iterable, an iterable, or a Response",
  );
}

async function collectEvents(
  source: StreamSource,
  timeoutMs?: number,
): Promise<StreamEvent[]> {
  // `expectStream` buffers the whole source before asserting. Without a bound,
  // a stream that never terminates hangs until Vitest's per-test timeout —
  // a poor signal. When a timeout is given, surface a clear, kit-specific
  // error instead. The pending collection is abandoned (it cannot be force
  // -cancelled), so callers should pair this with an aborting source.
  if (timeoutMs === undefined) return collectEventsInner(source);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `expectStream: stream did not terminate within ${timeoutMs}ms. ` +
              "Ensure the source ends, or raise the { timeout } option.",
          ),
        ),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([collectEventsInner(source), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Options for {@link expectStream}. */
export interface ExpectStreamOptions {
  /**
   * Fail with a clear error if the source has not finished within this many
   * milliseconds, instead of hanging until the test runner's own timeout.
   * Omit to buffer the source with no bound (the default).
   */
  timeout?: number;
}

/** Does `expected` appear as an in-order subsequence of `actual`? */
function isSubsequence(actual: string[], expected: string[]): boolean {
  let i = 0;
  for (const type of actual) {
    if (i < expected.length && type === expected[i]) i++;
    if (i === expected.length) break;
  }
  return i === expected.length;
}

/**
 * Consume a stream and make ordered assertions about the event types it emits.
 *
 * Deterministic and network-free: pair it with {@link createTestPluginContext} to
 * exercise a plugin's streaming handler and assert what it emits.
 *
 * @example Async event stream (adapter output)
 * ```ts
 * await expectStream(agent.adapter.run(input)).toEmit("tool_call", "message_delta");
 * ```
 *
 * @example SSE HTTP response
 * ```ts
 * const res = await fetch("/api/analytics/query/top_users", { method: "POST" });
 * await expectStream(res).toEmit("warehouse_status", "result");
 * ```
 *
 * @example Guard against a non-terminating stream
 * ```ts
 * await expectStream(handler.stream(req), { timeout: 1000 }).toEmit("result");
 * ```
 *
 * @param source - The stream, iterable, or SSE `Response` to consume.
 * @param options - See {@link ExpectStreamOptions}; pass `{ timeout }` to fail
 *   fast on a stream that never ends.
 */
export function expectStream(
  source: StreamSource,
  options: ExpectStreamOptions = {},
): StreamAssertion {
  const events = collectEvents(source, options.timeout);

  return {
    async collect() {
      return events;
    },
    async collectTypes() {
      return (await events).map(eventType);
    },
    async toEmit(...eventTypes: string[]) {
      const types = (await events).map(eventType);
      if (!isSubsequence(types, eventTypes)) {
        throw new Error(
          `expectStream(...).toEmit: expected events ${JSON.stringify(
            eventTypes,
          )} in order, but stream emitted ${JSON.stringify(types)}`,
        );
      }
      return types;
    },
    async toEmitExactly(...eventTypes: string[]) {
      const types = (await events).map(eventType);
      const equal =
        types.length === eventTypes.length &&
        types.every((t, i) => t === eventTypes[i]);
      if (!equal) {
        throw new Error(
          `expectStream(...).toEmitExactly: expected exactly ${JSON.stringify(
            eventTypes,
          )}, but stream emitted ${JSON.stringify(types)}`,
        );
      }
      return types;
    },
  };
}

/**
 * Parse an SSE `Response` and return its **last** event flattened to
 * `{ eventType, ...data }`.
 *
 * A convenience for one-shot assertions on a reply's final event; prefer
 * {@link expectStream} for multi-event ordering. It shares {@link parseSSEBody}
 * with `expectStream`, so the two never diverge on CRLF handling, comment
 * lines, or field parsing.
 *
 * @throws if the response carries no data-bearing event.
 */
export async function parseSSEResponse(response: Response): Promise<{
  eventType: string | null;
  [key: string]: unknown;
}> {
  const text = await response.text();
  const events = parseSSEBody(text);
  const last = events.at(-1);

  if (!last) {
    throw new Error(`No data found in SSE response: ${text}`);
  }

  // `parseSSEBody` already spread the JSON payload's fields onto the event and
  // set `type` from the wire name. Re-key `type` -> `eventType` for this
  // helper's historical shape, dropping the internal `type` alias.
  const { type, ...rest } = last;
  return { eventType: type ?? null, ...rest };
}
