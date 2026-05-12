import { z } from "zod";

/**
 * Wire protocol for analytics SSE messages emitted by `/api/analytics/query`.
 *
 * These schemas are the single source of truth for the contract between the
 * server (`AnalyticsPlugin._handleQueryRoute`) and the client
 * (`useAnalyticsQuery`). Both sides validate with the same schema:
 *
 * - Server uses the typed builders (`makeResultMessage`, `makeArrowMessage`,
 *   `makeArrowInlineMessage`) to construct messages with compile-time
 *   guarantees that all required fields are present.
 * - Client calls `AnalyticsSseMessage.parse(JSON.parse(event.data))` to fail
 *   loudly on a malformed payload instead of silently treating an undefined
 *   field as data.
 *
 * Adding a new message variant requires a schema update here, which keeps
 * server and client in lockstep.
 */

/** Successful row-shaped result (JSON_ARRAY format, or empty results). */
export const AnalyticsResultMessage = z.object({
  type: z.literal("result"),
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  // Status is opaque metadata forwarded from the warehouse — keep it as
  // `unknown` so we don't bake the SDK's detailed shape into the contract.
  status: z.unknown().optional(),
  statement_id: z.string().optional(),
});
export type AnalyticsResultMessage = z.infer<typeof AnalyticsResultMessage>;

/**
 * ARROW_STREAM result delivered via /arrow-result/:jobId — used for
 * EXTERNAL_LINKS responses (statement_id from the warehouse) and, if PR #320
 * lands, also for INLINE responses (synthetic `inline-` prefixed id from
 * the server-side stash).
 */
export const AnalyticsArrowMessage = z.object({
  type: z.literal("arrow"),
  statement_id: z.string().min(1),
  status: z.unknown().optional(),
});
export type AnalyticsArrowMessage = z.infer<typeof AnalyticsArrowMessage>;

/**
 * ARROW_STREAM + INLINE result with the base64-encoded Arrow IPC bytes
 * embedded in the SSE message. The client decodes locally via
 * `ArrowClient.processArrowBuffer`.
 *
 * Note: this variant goes away if the proposal in PR #320 lands.
 */
export const AnalyticsArrowInlineMessage = z.object({
  type: z.literal("arrow_inline"),
  attachment: z.string().min(1),
});
export type AnalyticsArrowInlineMessage = z.infer<
  typeof AnalyticsArrowInlineMessage
>;

/** Discriminated union of every message the analytics SSE stream may emit. */
export const AnalyticsSseMessage = z.discriminatedUnion("type", [
  AnalyticsResultMessage,
  AnalyticsArrowMessage,
  AnalyticsArrowInlineMessage,
]);
export type AnalyticsSseMessage = z.infer<typeof AnalyticsSseMessage>;

// ────────────────────────────────────────────────────────────────────────────
// Typed builders — call from the server route handler. The compiler enforces
// that every required field is supplied, and the return type narrows so
// downstream code (executeStream / SSE writer) keeps full type information.
// ────────────────────────────────────────────────────────────────────────────

export function makeResultMessage(
  data: Record<string, unknown>[] | undefined,
  extras: { status?: unknown; statement_id?: string } = {},
): AnalyticsResultMessage {
  return { type: "result", data, ...extras };
}

export function makeArrowMessage(
  statement_id: string,
  extras: { status?: unknown } = {},
): AnalyticsArrowMessage {
  return { type: "arrow", statement_id, ...extras };
}

export function makeArrowInlineMessage(
  attachment: string,
): AnalyticsArrowInlineMessage {
  return { type: "arrow_inline", attachment };
}
