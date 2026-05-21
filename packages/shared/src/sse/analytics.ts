import { z } from "zod";

/**
 * Wire protocol for analytics SSE messages emitted by `/api/analytics/query`.
 *
 * These schemas are the single source of truth for the contract between the
 * server (`AnalyticsPlugin._handleQueryRoute`) and the client
 * (`useAnalyticsQuery`). Both sides validate with the same schema:
 *
 * - Server uses the typed builders (`makeResultMessage`, `makeArrowMessage`)
 *   to construct messages with compile-time guarantees that all required
 *   fields are present.
 * - Client calls `AnalyticsSseMessage.parse(JSON.parse(event.data))` to fail
 *   loudly on a malformed payload instead of silently treating an undefined
 *   field as data.
 *
 * Arrow payloads — inline or external-links — never traverse the SSE control
 * channel; both flow through `/api/analytics/arrow-result/:jobId` and are
 * differentiated by an `inline-` prefix on the job id (see
 * `InlineArrowStash`). The wire shape from the client's perspective is
 * therefore uniform: an `arrow` message carries an id, the client fetches.
 *
 * Adding a new message variant requires a schema update here, which keeps
 * server and client in lockstep.
 */

/** Successful row-shaped result (JSON_ARRAY format, or empty results). */
export const AnalyticsResultMessage = z.object({
  type: z.literal("result"),
  // `data` is intentionally `z.array(z.unknown())` rather than a deep
  // row schema. Validating every row's keys for shape costs O(rows × cols)
  // CPU and main-thread blocking time on the *client* (the schema is
  // also reused for `safeParse` in `useAnalyticsQuery`); for large JSON
  // results that pushes hundreds of ms to seconds of TBT into the
  // render pipeline. The server constructs `data` via the typed
  // `makeResultMessage` builder, so the per-row shape is enforced at
  // the source, not at validation time. The TS-level interface below
  // narrows `data` to `Record<string, unknown>[]` for callers.
  data: z.array(z.unknown()).optional(),
  // Status is opaque metadata forwarded from the warehouse — keep it as
  // `unknown` so we don't bake the SDK's detailed shape into the contract.
  status: z.unknown().optional(),
  statement_id: z.string().optional(),
});

/**
 * TS-level shape of a successful row-shaped result message.
 *
 * **Kept in sync by hand** with `AnalyticsResultMessage` above. The Zod
 * schema is intentionally loose (`z.array(z.unknown())`) to keep client
 * validation cheap; this interface narrows `data` to
 * `Record<string, unknown>[]` so consumers don't have to cast at every
 * call site. If you add a field to the Zod schema, add it here too.
 */
export interface AnalyticsResultMessage {
  type: "result";
  data?: Record<string, unknown>[];
  status?: unknown;
  statement_id?: string;
}

/**
 * ARROW_STREAM result delivered via /arrow-result/:jobId. The id is either:
 * - the warehouse-issued `statement_id` for EXTERNAL_LINKS responses, or
 * - a synthetic `inline-<uuid>` id pointing at the server-side
 *   `InlineArrowStash` for INLINE responses.
 *
 * Both shapes are fetched the same way; the prefix tells the route handler
 * which path to take.
 */
export const AnalyticsArrowMessage = z.object({
  type: z.literal("arrow"),
  statement_id: z.string().min(1),
  status: z.unknown().optional(),
});
export type AnalyticsArrowMessage = z.infer<typeof AnalyticsArrowMessage>;

/** Discriminated union of every message the analytics SSE stream may emit. */
export const AnalyticsSseMessage = z.discriminatedUnion("type", [
  AnalyticsResultMessage,
  AnalyticsArrowMessage,
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
