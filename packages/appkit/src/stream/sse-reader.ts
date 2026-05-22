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
 * Configuration for {@link readSseEvents}. All limits are in UTF-16 code
 * units (JS string `.length`) and exist as a DoS guard (CWE-770) for
 * untrusted upstreams that might stream arbitrarily large lines or never
 * emit a block terminator.
 */
interface ReadSseEventsOptions {
  /**
   * Maximum length of any single SSE event block (i.e. the text between
   * two `\n\n` separators). Exceeding this throws.
   *
   * @default 1 MiB (1_048_576)
   */
  maxLineChars?: number;
  /**
   * Maximum length of the rolling input buffer when no block terminator
   * has been seen yet. Exceeding this throws — protects against an
   * upstream that streams indefinitely without ever sending `\n\n`.
   *
   * @default 8 MiB (8_388_608)
   */
  maxBufferChars?: number;
}

const DEFAULT_MAX_SSE_LINE_CHARS = 1024 * 1024;
const DEFAULT_MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;

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
 * lock in either case. Throws when {@link ReadSseEventsOptions.maxLineChars}
 * or {@link ReadSseEventsOptions.maxBufferChars} are exceeded.
 */
export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options?: ReadSseEventsOptions,
): AsyncGenerator<SseEvent, void, unknown> {
  const maxLineChars = options?.maxLineChars ?? DEFAULT_MAX_SSE_LINE_CHARS;
  const maxBufferChars =
    options?.maxBufferChars ?? DEFAULT_MAX_SSE_BUFFER_CHARS;

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
        if (buffer.length > maxLineChars) {
          throw new Error(
            `readSseEvents: trailing SSE block exceeds maxLineChars (${maxLineChars} UTF-16 code units)`,
          );
        }
        const tail = parseSseBlock(buffer);
        if (tail) yield tail;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Gate the CRLF normalize on `\r` presence — saves a full-buffer
      // regex scan on every chunk for the common LF-only steady state.
      const normalized =
        buffer.indexOf("\r") !== -1 ? buffer.replace(/\r\n/g, "\n") : buffer;
      const blocks = normalized.split("\n\n");
      // Last entry is either an incomplete block or "" (when the chunk ended
      // exactly on a boundary). Either way, keep it for the next iteration.
      buffer = blocks.pop() ?? "";

      if (buffer.length > maxBufferChars) {
        throw new Error(
          `readSseEvents: incomplete SSE block exceeds maxBufferChars (${maxBufferChars} UTF-16 code units) without a terminator`,
        );
      }

      for (const block of blocks) {
        if (block.length > maxLineChars) {
          throw new Error(
            `readSseEvents: SSE block exceeds maxLineChars (${maxLineChars} UTF-16 code units)`,
          );
        }
        const event = parseSseBlock(block);
        if (event) yield event;
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * Per the SSE spec, only a single leading `U+0020` is stripped from a field
 * value — not arbitrary whitespace. `trimStart()` would also strip tabs,
 * NBSP, etc.; for callers that feed binary or whitespace-prefixed payloads
 * this is a footgun.
 */
function stripOneLeadingSpace(s: string): string {
  return s.startsWith(" ") ? s.slice(1) : s;
}

function parseSseBlock(block: string): SseEvent | null {
  if (block.length === 0) return null;
  // CRLF was already normalised at the buffer level, so each `line` here is
  // already free of trailing `\r` — no per-line strip needed.
  const lines = block.split("\n");

  let eventName = "";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;

    if (line.startsWith("event:")) {
      eventName = stripOneLeadingSpace(line.slice(6));
    } else if (line.startsWith("data:")) {
      dataLines.push(stripOneLeadingSpace(line.slice(5)));
    } else if (line.startsWith("id:")) {
      id = stripOneLeadingSpace(line.slice(3));
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
