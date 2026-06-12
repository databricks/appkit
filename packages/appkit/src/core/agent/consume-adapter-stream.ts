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
 * Per-round rule (shared across all agent-execution paths in AppKit):
 *
 * - `message_delta` events append their `content` to the message currently
 *   being built.
 * - A `message` event *replaces* the message currently being built with its
 *   `content` (LangChain's `on_chain_end` path emits a single final message).
 * - A `tool_call` / `tool_result` event closes the current message: any text
 *   accumulated so far is a *draft* that the model emitted alongside its tool
 *   calls, so it is set aside as "the last closed message" and the buffer is
 *   reset for the next ReAct round.
 *
 * The return value is the text of the message currently open at end-of-stream
 * (the terminal answer in a normal ReAct loop), falling back to the last
 * closed message if the stream ended mid-tool-calling (e.g. `maxSteps`
 * exhausted right after a tool call).
 *
 * Why per-round and not flat concatenation: with OpenAI-compatible Claude on
 * Databricks Model Serving, the model emits a full draft answer ALONGSIDE its
 * tool calls on every round, so a naive `text += content` accumulation
 * surfaces that draft 3-4× in the final text. Only the final round's message
 * is the real answer; each tool call marks a round boundary. The
 * `AgentEventTranslator` already item-bounds these rounds on the wire — this
 * loop mirrors that boundary so server-side consumers (thread history, the
 * non-streaming JSON `fullContent`, `runAgent`, and sub-agents) dedupe too.
 *
 * Kept pure (no I/O, no mutable external state beyond the caller's `onEvent`
 * side effect) so each execution path — HTTP streaming, sub-agents, and the
 * standalone `runAgent` — can share one loop.
 */
export async function consumeAdapterStream(
  stream: AsyncIterable<AgentEvent>,
  opts: ConsumeAdapterStreamOptions = {},
): Promise<string> {
  let current = ""; // text of the message currently being built
  let lastClosed = ""; // most recent fully-closed message
  for await (const event of stream) {
    if (opts.signal?.aborted) break;
    if (event.type === "message_delta") {
      current += event.content;
    } else if (event.type === "message") {
      // LangChain single-final replace — preserve.
      current = event.content;
    } else if (event.type === "tool_call" || event.type === "tool_result") {
      // A draft followed by a tool call is superseded by the next round.
      if (current) {
        lastClosed = current;
        current = "";
      }
    }
    opts.onEvent?.(event);
  }
  // Terminal answer, or the last draft if maxSteps exhausted mid-tool-calling.
  return current || lastClosed;
}
