import type { AgentEvent } from "shared";

/**
 * Stream-protocol-agnostic translator: converts AppKit's internal
 * {@link AgentEvent} stream into a wire-specific event/chunk type `T`.
 *
 * One instance per streaming request — implementations are stateful (e.g.
 * lazy text-message open/close, sequence numbers). Translators are
 * exclusively output-side: they never decide what to invoke or how to call
 * the model, only how to encode the agent's already-produced events.
 *
 * Concrete implementations:
 * - `AgentEventTranslator` — Responses-API SSE wire format (legacy default).
 * - `VercelAIUIMessageStreamTranslator` — Vercel AI SDK
 *   {@link https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocols UI Message Stream}
 *   chunks consumed by `@ai-sdk/react`'s `useChat`.
 */
export interface AgentEventStreamTranslator<T> {
  /** Translate a single internal event into zero or more wire chunks. */
  translate(event: AgentEvent): T[];
  /**
   * Emit any terminal chunks (e.g. closing an open text item, a `finish`
   * marker). Idempotent — safe to call multiple times; only the first call
   * yields output.
   */
  finalize(): T[];
}
