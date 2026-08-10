import type {
  BasePluginConfig,
  MetricFilter,
  MetricOrderBy,
  MetricViewColumnDisplay,
  MetricViewsMetadata,
} from "shared";

export type {
  MetricFilter,
  MetricFilterOperatorName,
  MetricOrderBy,
  MetricPredicate,
} from "shared";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
  /**
   * The metric route stamps the slice of this scoped to a request's
   * measures/dimensions into the SSE `result` message.
   * Absent → the `result` message carries no `metadata` field, leaving it
   * envelope-identical to `/query`.
   */
  metricViewsMetadata?: MetricViewsMetadata;
  warehouseStartupTimeoutMs?: number;
  /**
   * @default true
   */
  autoStartWarehouse?: boolean;
  /**
   * Fail-fast ceiling (ms) for an `ARROW_STREAM` query to produce its first
   * byte (warehouse readiness + execute + first chunk). Past this, a stuck or
   * overloaded warehouse returns a `503` (`WAREHOUSE_UNAVAILABLE`) instead of
   * hanging until the client disconnects.
   * Defaults to 2 min.
   */
  arrowFirstByteTimeoutMs?: number;
}

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
 * Discriminated union of every SSE message shape emitted by the analytics
 * routes (`POST /api/analytics/query/:query_key` and
 * `POST /api/analytics/metric/:key`).
 */
export type AnalyticsStreamMessage =
  | { type: "warehouse_status"; status: WarehouseStatus }
  | {
      type: "result";
      data?: unknown[];
      status?: unknown;
      statement_id?: string;
      metadata?: Record<string, MetricViewColumnDisplay>;
    }
  | {
      type: "arrow";
      statement_id: string;
      status: { state: string };
    }
  | { type: "error"; error: string; code?: string; errorCode?: string };

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

// ────────────────────────────────────────────────────────────────────────────
// Metric views — POST /api/analytics/metric/:key
// ────────────────────────────────────────────────────────────────────────────

/**
 * Execution lane for a registered metric view, derived from the entry's
 * `executor` in `definitions.json`:
 *   - `"sp"`  ← `executor: "app_service_principal"` — queried as the app
 *     service principal (cache shared across all users).
 *   - `"obo"` ← `executor: "user"` — queried on-behalf-of the requesting
 *     user (per-user cache) via `asUser(req)`.
 */
export type MetricLane = "sp" | "obo";

/**
 * A single registered metric view, loaded from `config/metric-views/definitions.json`.
 *
 * The registration carries only what the runtime needs to build and dispatch
 * SQL: the metric `key`, the three-part UC FQN `source`, and the `lane`. There
 * is intentionally NO build-time measure/dimension metadata here — the security
 * boundary is the grammar gate plus parameterized values, not a name allowlist,
 * so the runtime never enumerates known measures/dimensions.
 */
export interface MetricRegistration {
  key: string;
  source: string;
  lane: MetricLane;
}

/**
 * Validated request body for `POST /api/analytics/metric/:key`.
 *
 * `measures` is required. `dimensions` drive `GROUP BY ALL`; `filter` is the
 * recursive structured predicate tree translated into a parameterized `WHERE`
 * clause. `timeGrain` buckets the single dimension named by `timeDimension`
 * via `date_trunc`; it requires `timeDimension`, and `timeDimension` must be
 * one of `dimensions` so it is selected and in `GROUP BY ALL`. Both tokens are
 * grammar-gated before they reach SQL. `orderBy` controls row ordering; when
 * `limit` is set, any dimensions not named in `orderBy` are appended as
 * tie-breakers so the ordering is total and `LIMIT` is deterministic.
 */
export interface IAnalyticsMetricRequest {
  measures: string[];
  dimensions?: string[];
  filter?: MetricFilter;
  timeGrain?: string;
  /**
   * The single dimension that `timeGrain` buckets via `date_trunc`. Must be
   * one of `dimensions` (so it is selected and in `GROUP BY ALL`) and is
   * required whenever `timeGrain` is set. Grammar-gated as a SQL identifier.
   */
  timeDimension?: string;
  orderBy?: MetricOrderBy[];
  limit?: number;
  format?: AnalyticsFormat;
}
