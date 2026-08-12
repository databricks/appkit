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
  /** @internal Bounds cleanup when an adapter violates lifecycle finalization. */
  cancellationDrain?: {
    timeoutMs?: number;
    maxEvents?: number;
  };
}

const DEFAULT_CANCELLATION_DRAIN_TIMEOUT_MS = 1_000;
const DEFAULT_CANCELLATION_DRAIN_MAX_EVENTS = 256;
const CANCELLATION_FINALIZER_ERROR =
  "Model stream cancellation finalizer unavailable";

type ModelStartEvent = Extract<AgentEvent, { type: "model_start" }>;

function boundedInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.floor(value));
}

function requestIteratorCleanup(iterator: AsyncIterator<AgentEvent>): void {
  try {
    const cleanup = iterator.return?.();
    if (cleanup) void Promise.resolve(cleanup).catch(() => {});
  } catch {
    // Cleanup is best-effort and must never replace the bounded result.
  }
}

async function raceNextWithAbort(
  next: Promise<IteratorResult<AgentEvent>>,
  signal: AbortSignal,
): Promise<
  { type: "next"; result: IteratorResult<AgentEvent> } | { type: "abort" }
> {
  if (signal.aborted) return { type: "abort" };
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve({ type: "abort" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    next.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ type: "next", result });
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function raceNextWithTimeout(
  next: Promise<IteratorResult<AgentEvent>>,
  timeoutMs: number,
): Promise<
  { type: "next"; result: IteratorResult<AgentEvent> } | { type: "timeout" }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      next.then((result) => ({ type: "next" as const, result })),
      new Promise<{ type: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
  const activeModelSteps = new Map<string, ModelStartEvent>();
  const consumedModelSteps = new Set<string>();
  let remoteTrace: ConsumedAgentStream["remoteTrace"];
  const timeoutMs = boundedInteger(
    opts.cancellationDrain?.timeoutMs,
    DEFAULT_CANCELLATION_DRAIN_TIMEOUT_MS,
  );
  const maxEvents = boundedInteger(
    opts.cancellationDrain?.maxEvents,
    DEFAULT_CANCELLATION_DRAIN_MAX_EVENTS,
  );
  let drainDeadline: number | undefined;
  let drainedEvents = 0;
  const iterator = stream[Symbol.asyncIterator]();

  const consumeEvent = (event: AgentEvent): void => {
    if (event.type === "message_delta") {
      text += event.content;
    } else if (event.type === "message") {
      text = event.content;
    } else if (event.type === "model_start") {
      activeModelSteps.set(event.stepId, event);
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
  };

  const synthesizeCancellationFinalizers = (): void => {
    const endedAt = Date.now();
    for (const start of [...activeModelSteps.values()]) {
      consumeEvent({
        type: "model_end",
        stepId: start.stepId,
        model: start.model,
        provider: start.provider,
        output: { text: "", toolCalls: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costAvailable: false,
        },
        finishReason: "cancelled",
        streamDurationMs: 0,
        endedAt,
        error: CANCELLATION_FINALIZER_ERROR,
      });
    }
  };

  let stopEarly = false;
  while (true) {
    if (opts.signal?.aborted) {
      if (activeModelSteps.size === 0) {
        stopEarly = true;
        break;
      }
      drainDeadline ??= Date.now() + timeoutMs;
      if (drainedEvents >= maxEvents || Date.now() >= drainDeadline) {
        synthesizeCancellationFinalizers();
        stopEarly = true;
        break;
      }
    }

    const pendingNext = Promise.resolve(iterator.next());
    let next: IteratorResult<AgentEvent>;
    if (opts.signal && !opts.signal.aborted) {
      const raced = await raceNextWithAbort(pendingNext, opts.signal);
      if (raced.type === "abort") {
        if (activeModelSteps.size === 0) {
          void pendingNext.catch(() => {});
          stopEarly = true;
          break;
        }
        drainDeadline ??= Date.now() + timeoutMs;
        const bounded = await raceNextWithTimeout(
          pendingNext,
          Math.max(0, drainDeadline - Date.now()),
        );
        if (bounded.type === "timeout") {
          void pendingNext.catch(() => {});
          synthesizeCancellationFinalizers();
          stopEarly = true;
          break;
        }
        next = bounded.result;
      } else {
        next = raced.result;
      }
    } else if (opts.signal?.aborted && activeModelSteps.size > 0) {
      drainDeadline ??= Date.now() + timeoutMs;
      const bounded = await raceNextWithTimeout(
        pendingNext,
        Math.max(0, drainDeadline - Date.now()),
      );
      if (bounded.type === "timeout") {
        void pendingNext.catch(() => {});
        synthesizeCancellationFinalizers();
        stopEarly = true;
        break;
      }
      next = bounded.result;
    } else {
      next = await pendingNext;
    }

    if (next.done) break;
    const event = next.value;
    if (event.type === "model_start") {
      activeModelSteps.set(event.stepId, event);
    }
    const aborted = opts.signal?.aborted === true;
    if (!aborted) {
      consumeEvent(event);
      continue;
    }

    drainDeadline ??= Date.now() + timeoutMs;
    if (activeModelSteps.size === 0) {
      stopEarly = true;
      break;
    }
    drainedEvents += 1;
    if (
      event.type === "model_start" ||
      event.type === "model_end" ||
      event.type === "remote_trace"
    ) {
      consumeEvent(event);
    }
    if (activeModelSteps.size === 0) {
      stopEarly = true;
      break;
    }
    if (drainedEvents >= maxEvents || Date.now() >= drainDeadline) {
      synthesizeCancellationFinalizers();
      stopEarly = true;
      break;
    }
  }
  if (stopEarly) requestIteratorCleanup(iterator);
  return {
    text,
    usage: usage.snapshot(),
    ...(remoteTrace ? { remoteTrace } : {}),
  };
}
