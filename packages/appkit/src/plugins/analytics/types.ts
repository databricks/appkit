import type { BasePluginConfig } from "shared";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
  /**
   * Maximum time (ms) the analytics route waits for a STOPPED/STARTING SQL
   * warehouse to reach RUNNING before failing the request. Defaults to 5 min.
   */
  warehouseStartupTimeoutMs?: number;
  /**
   * When `true` (default), a `STOPPED` SQL warehouse is auto-started on the
   * first analytics request that reaches it. Set to `false` for cost-
   * controlled deployments where billable warehouse starts must not be
   * triggered by user requests; in that case `STOPPED` surfaces as a
   * `ConfigurationError`.
   */
  autoStartWarehouse?: boolean;
}

/**
 * SQL warehouse lifecycle states surfaced by the analytics route.
 * Mirrors the states emitted by the Databricks SQL SDK (`sql.State`).
 */
export type WarehouseState =
  | "RUNNING"
  | "STARTING"
  | "STOPPED"
  | "STOPPING"
  | "DELETED"
  | "DELETING";

/**
 * Snapshot of warehouse readiness streamed to the client over SSE before the
 * SQL result. Lets the UI render a "warehouse starting…" affordance instead
 * of a frozen spinner during cold starts.
 *
 * Note: the SDK's `health.summary` is intentionally NOT forwarded here. It's
 * free-form operator-oriented diagnostic text (cluster IDs, capacity-failure
 * reasons, internal RPC errors) that must not reach end users; it stays in
 * server-side telemetry only.
 */
export interface WarehouseStatus {
  state: WarehouseState;
  /** Milliseconds elapsed since the route began waiting for the warehouse. */
  elapsedMs: number;
}

/**
 * Discriminated union of every SSE message shape emitted by
 * `POST /api/analytics/query/:query_key`. Useful for typing the client-side
 * `onMessage` handler (and is the source of truth re-mirrored in
 * `appkit-ui` since that package can't depend on `appkit`).
 */
export type AnalyticsStreamMessage =
  | { type: "warehouse_status"; status: WarehouseStatus }
  | { type: "result"; data: unknown[] }
  | {
      type: "arrow";
      statement_id: string;
      status: { state: string };
    }
  | { type: "error"; error: string; code?: string };

/**
 * Supported response formats for analytics queries.
 *
 * "JSON" and "ARROW" are legacy aliases kept for backwards compatibility
 * with appkit/appkit-ui < 0.33.0 — safe to remove once no consumer is on
 * a pre-0.33.0 version. The route handler normalizes them to their
 * canonical equivalents before any downstream code reads the value.
 */
export type AnalyticsFormat =
  | "JSON_ARRAY"
  | "ARROW_STREAM"
  /** @deprecated Use "JSON_ARRAY". Safe to remove once no consumer is on appkit < 0.33.0. */
  | "JSON"
  /** @deprecated Use "ARROW_STREAM". Safe to remove once no consumer is on appkit < 0.33.0. */
  | "ARROW";

/** Canonical (post-normalization) analytics format values. */
type CanonicalAnalyticsFormat = "JSON_ARRAY" | "ARROW_STREAM";

/**
 * Map a (possibly legacy) AnalyticsFormat to its canonical form.
 * Legacy values come from appkit/appkit-ui < 0.33.0 and can be removed
 * along with the deprecated aliases once no such consumer remains.
 */
export function normalizeAnalyticsFormat(
  f: AnalyticsFormat,
): CanonicalAnalyticsFormat {
  if (f === "JSON") return "JSON_ARRAY";
  if (f === "ARROW") return "ARROW_STREAM";
  return f;
}

export interface IAnalyticsQueryRequest {
  parameters?: Record<string, any>;
  format?: AnalyticsFormat;
}

export interface AnalyticsQueryResponse {
  chunk_index: number;
  row_offset: number;
  row_count: number;
  data: any[];
}
