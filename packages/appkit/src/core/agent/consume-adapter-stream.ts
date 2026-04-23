import type { AgentEvent } from "shared";

interface ConsumeAdapterStreamOptions {
  /**
   * Optional abort signal. When aborted, the loop stops consuming (the caller
   * is expected to have forwarded the same signal to `adapter.run` to stop
   * upstream work). `undefined` is valid — standalone `runAgent` runs without
   * a signal.
   */
  signal?: AbortSignal;
  /**
   * Side-effect callback invoked once per adapter event, after the content
   * accumulator has been updated. Use to fan events out to SSE translators,
   * collect a raw event list for tests, or emit telemetry.
   */
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Consume an adapter's event stream and aggregate the assistant's final text.
 *
 * Accumulation rule (shared across all agent-execution paths in AppKit):
 *
 * - `message_delta` events append their `content` to the running text.
 * - A `message` event *replaces* the running text with its `content`.
 *
 * The two branches coexist because different adapters emit different shapes:
 * streaming adapters (Databricks, Vercel AI) emit deltas chunk-by-chunk,
 * while `LangChain`'s `on_chain_end` path emits a single final `message`.
 * Without the replace branch, LangChain conversations silently dropped the
 * assistant turn from thread history.
 *
 * Kept pure (no I/O, no mutable external state beyond the caller's `onEvent`
 * side effect) so each execution path — HTTP streaming, sub-agents, and the
 * standalone `runAgent` — can share one loop.
 */
export async function consumeAdapterStream(
  stream: AsyncIterable<AgentEvent>,
  opts: ConsumeAdapterStreamOptions = {},
): Promise<string> {
  let text = "";
  for await (const event of stream) {
    if (opts.signal?.aborted) break;
    if (event.type === "message_delta") {
      text += event.content;
    } else if (event.type === "message") {
      text = event.content;
    }
    opts.onEvent?.(event);
  }
  return text;
}
