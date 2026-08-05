import { z } from "zod";
import type { MetricViewColumnDisplay } from "../metric-metadata";

/**
 * Wire protocol for analytics SSE messages emitted by `/api/analytics/query`.
 *
 * The SSE channel carries only the JSON_ARRAY path (warehouse-readiness
 * events + a `result` message of rows). ARROW_STREAM does NOT use SSE —
 * the server streams the raw Arrow IPC bytes back on the query response body
 * (`_handleArrowStreamQuery`) and the client reads them directly
 * (`fetchArrowDirect`), so there is no `arrow` message type here.
 *
 * These schemas are the single source of truth for the JSON contract between
 * the server (`AnalyticsPlugin._handleQueryRoute`) and the client
 * (`useAnalyticsQuery`). Both sides validate with the same schema:
 *
 * - Server uses the typed builder (`makeResultMessage`) to construct messages
 *   with compile-time guarantees that all required fields are present.
 * - Client calls `AnalyticsSseMessage.safeParse(JSON.parse(event.data))` to
 *   fail loudly on a malformed payload instead of silently treating an
 *   undefined field as data.
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
  // Per-column display metadata for a metric-view result (display_name /
  // format / type). Kept loose (`z.record(z.string(), z.unknown())`) for the
  // same "keep client validation cheap" reason as `data` — the server
  // constructs it via the typed builder, so the per-column shape is enforced
  // at the source. Absent for plain `/query` results.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * TS-level shape of a successful row-shaped result message.
 *
 * **Kept in sync by hand** with `AnalyticsResultMessage` above. The Zod
 * schema is intentionally loose (`z.array(z.unknown())` for `data`,
 * `z.record(z.string(), z.unknown())` for `metadata`) to keep client
 * validation cheap; this interface narrows `data` to
 * `Record<string, unknown>[]` and `metadata` to
 * `Record<string, MetricViewColumnDisplay>` so consumers don't have to cast
 * at every call site. If you add a field to the Zod schema, add it here too.
 */
export interface AnalyticsResultMessage {
  type: "result";
  data?: Record<string, unknown>[];
  status?: unknown;
  statement_id?: string;
  metadata?: Record<string, MetricViewColumnDisplay>;
}

/**
 * Every message the analytics SSE stream may emit. Currently only the
 * row-shaped `result` message (JSON_ARRAY path); `warehouse_status` and
 * `error` events are handled off-schema by the client. ARROW_STREAM never
 * uses SSE.
 */
export const AnalyticsSseMessage = AnalyticsResultMessage;
export type AnalyticsSseMessage = z.infer<typeof AnalyticsSseMessage>;

// ────────────────────────────────────────────────────────────────────────────
// Typed builder — call from the server route handler. The compiler enforces
// that every required field is supplied, and the return type narrows so
// downstream code (executeStream / SSE writer) keeps full type information.
// ────────────────────────────────────────────────────────────────────────────

export function makeResultMessage(
  data: Record<string, unknown>[] | undefined,
  extras: {
    status?: unknown;
    statement_id?: string;
    metadata?: Record<string, MetricViewColumnDisplay>;
  } = {},
): AnalyticsResultMessage {
  return { type: "result", data, ...extras };
}
