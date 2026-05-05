/**
 * One parsed Server-Sent Event. Field names follow the spec:
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * The reader does not interpret `data` (no JSON parsing), so callers control
 * the wire shape they expect.
 */
export interface SseEvent {
  /** Value of the most recent `event:` field, or `""` for an unnamed event. */
  event: string;
  /** Joined `data:` lines for the event (empty string when no data was set). */
  data: string;
  /** Value of the most recent `id:` field, or `undefined` if none. */
  id?: string;
}

/**
 * Async-iterates Server-Sent Events from a UTF-8 byte stream.
 *
 * Block-oriented parser: events are delimited by blank lines (`\n\n` after
 * CRLF normalization), so an `event:` line in chunk N pairs correctly with a
 * `data:` line in chunk N+1 — no hoisted state needed.
 *
 * The reader passes through the sentinel string `[DONE]` as `event=""`,
 * `data="[DONE]"`. Callers that care about it should match `data === "[DONE]"`
 * after destructuring.
 *
 * Terminates when the stream closes or `signal` aborts; releases the reader
 * lock in either case.
 */
export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Cancel the reader on abort so an in-flight `reader.read()` returns
  // immediately instead of waiting for the next chunk. Without this, an
  // aborted consumer would only notice between reads — fine for chatty
  // streams, but unbounded for an idle/heartbeat-less upstream.
  const onAbort = () => {
    reader.cancel().catch(() => {
      // `cancel()` rejects if the stream is already errored/closed; ignore.
    });
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) {
        const tail = parseSseBlock(buffer);
        if (tail) yield tail;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const normalized = buffer.replace(/\r\n/g, "\n");
      const blocks = normalized.split("\n\n");
      // Last entry is either an incomplete block or "" (when the chunk ended
      // exactly on a boundary). Either way, keep it for the next iteration.
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event) yield event;
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SseEvent | null {
  if (block.length === 0) return null;
  const lines = block.split("\n");

  let eventName = "";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "" || line.startsWith(":")) continue;

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trimStart();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.startsWith("id:")) {
      id = line.slice(3).trimStart();
    }
    // Other fields (`retry:`, custom) are ignored by design.
  }

  // Per the SSE spec, a block is only dispatched when the data buffer is
  // non-empty. Blocks containing only `event:`/`id:` (or comments) do not
  // surface as events.
  if (dataLines.length === 0) return null;

  return {
    event: eventName,
    data: dataLines.join("\n"),
    id,
  };
}
