import type { AgentEvent, AgentRemoteTraceEvent } from "shared";
import {
  AgentUsageAccumulator,
  type ConsumedAgentStream,
} from "../../telemetry/agent-tracing";

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

function isValidRemoteTrace(event: AgentEvent): event is AgentRemoteTraceEvent {
  if (
    event.type !== "remote_trace" ||
    typeof event.traceId !== "string" ||
    !event.traceId.trim()
  ) {
    return false;
  }
  if (
    event.source !== "model-serving" &&
    event.source !== "supervisor" &&
    event.source !== "remote-agent"
  ) {
    return false;
  }
  if (event.relation === "continued") return true;
  return (
    event.relation === "linked" &&
    typeof event.spanId === "string" &&
    event.spanId.trim().length > 0
  );
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
): Promise<ConsumedAgentStream> {
  let text = "";
  const usage = new AgentUsageAccumulator();
  const activeModelSteps = new Set<string>();
  const consumedModelSteps = new Set<string>();
  let remoteTrace: ConsumedAgentStream["remoteTrace"];
  for await (const event of stream) {
    const aborted = opts.signal?.aborted === true;
    if (event.type === "model_start") activeModelSteps.add(event.stepId);
    if (aborted) {
      if (activeModelSteps.size === 0) break;
      if (
        event.type !== "model_start" &&
        event.type !== "model_end" &&
        event.type !== "remote_trace"
      ) {
        continue;
      }
    }
    if (event.type === "message_delta") {
      text += event.content;
    } else if (event.type === "message") {
      text = event.content;
    } else if (event.type === "model_end") {
      activeModelSteps.delete(event.stepId);
      if (!consumedModelSteps.has(event.stepId)) {
        consumedModelSteps.add(event.stepId);
        usage.add(event.usage);
      }
    } else if (isValidRemoteTrace(event)) {
      remoteTrace = event;
    }
    opts.onEvent?.(event);
    if (aborted && activeModelSteps.size === 0) break;
  }
  return {
    text,
    usage: usage.snapshot(),
    ...(remoteTrace ? { remoteTrace } : {}),
  };
}
