import type { DatabricksStatementExecutionResponse } from "../types";

/**
 * The lane an entry sits in: `sp` (service principal, shared cache)
 * or `obo` (on-behalf-of, per-user cache).
 *
 * Lanes are internal vocabulary — the config speaks `executor`
 * ("app_service_principal" | "user") and resolveMetricConfig derives the
 * lane at the parse boundary.
 */
export type MetricLane = "sp" | "obo";

/**
 * Single entry in the `metricViews` map of definitions.json.
 *
 * v1 allows `source` plus the optional `executor`. Object form (rather than
 * bare string) is the forward-compat seam for future per-entry options
 * (cacheTtl, defaultFilter, ...) — `executor` is the first such option.
 */
export interface MetricEntryConfig {
  source: string;
  executor?: "app_service_principal" | "user";
}

/**
 * Shape of definitions.json (mirrors `metricSourceSchema` in
 * `packages/shared/src/schemas/metric-source.ts`). Inlined here so the
 * type-generator does not pull in the shared schema package at runtime.
 */
export interface MetricSourceConfig {
  $schema?: string;
  metricViews?: Record<string, MetricEntryConfig>;
}

/**
 * Resolved entry consumed by the rest of the metric-view pipeline.
 * Lane is denormalized onto the entry so downstream code does not have to
 * re-derive it from the config's `executor` field.
 */
export interface ResolvedMetricEntry {
  /** Stable map key shared across route, hook, registry, and cache. */
  key: string;
  /** Three-part Unity Catalog FQN of the metric view. */
  source: string;
  /** Execution lane — sp = service principal, obo = on-behalf-of. */
  lane: MetricLane;
}

/**
 * Per-column metadata extracted from DESCRIBE TABLE EXTENDED ... AS JSON.
 */
export interface MetricColumnMetadata {
  name: string;
  type: string;
  /** UC marks columns produced by `MEASURE()` as measures; everything else is a dimension. */
  isMeasure: boolean;
  /** Optional column comment / display description (best-effort). */
  description?: string;
  /**
   * Human-readable display name from the YAML 1.1 `display_name` attribute.
   * Used by `formatLabel` as the canonical axis / legend / tooltip text;
   * absent → callers fall back to camelCase / snake_case humanization of `name`.
   */
  displayName?: string;
  /**
   * Printf-style format spec from the YAML 1.1 `format` attribute (e.g.
   * `"$#,##0.00"`, `"0.0%"`, `"#,##0"`).
   */
  format?: string;
  /**
   * Standard time-grain set for this column, inferred from the SQL data type:
   *   TIMESTAMP* → 7 grains (minute..year); DATE → 5 grains (day..year).
   * Undefined means the column is not time-typed. Measures never get grains.
   */
  timeGrains?: string[];
}

/**
 * Per-metric schema captured at type-generation time.
 *
 * The full row type is the union of measure + dimension column types;
 * time-typed dimensions additionally carry their inferred `timeGrains`.
 */
export interface MetricSchema {
  /** Stable metric key (the map key under `metricViews` in definitions.json). */
  key: string;
  /** Three-part FQN of the metric view. */
  source: string;
  /** Execution lane this metric was registered under. */
  lane: MetricLane;
  /** Measure columns (those exposed by MEASURE()). */
  measures: MetricColumnMetadata[];
  /** Dimension columns (everything that is not a measure). */
  dimensions: MetricColumnMetadata[];
  /**
   * `true` when the schema is unknown — the warehouse couldn't tell us
   * (DESCRIBE was skipped, returned a non-terminal state, was rejected, or
   * its response couldn't be parsed into columns). Absent/`false` means the
   * measures/dimensions are a real DESCRIBE result.
   */
  degraded?: boolean;
}

// Result of reading and resolving definitions.json — a flat entries list
// with the lane denormalized for iteration.
export interface MetricConfigResolution {
  entries: ResolvedMetricEntry[];
}

/**
 * Optional dependency-injection seam: the function used to fetch DESCRIBE
 * results for a given FQN. Production wires this through the WorkspaceClient;
 * tests inject a mock that returns a representative DESCRIBE response.
 */
export type DescribeFetcher = (
  fqn: string,
) => Promise<DatabricksStatementExecutionResponse>;

/**
 * One per-entry sync failure recorded by syncMetrics. Failures are surfaced
 * to the caller so they can decide whether to exit non-zero.
 */
export interface MetricSyncFailure {
  /** Stable metric key — matches the key under `metricViews` in definitions.json. */
  key: string;
  /** Three-part FQN that failed to resolve. */
  source: string;
  /** Single human-readable reason (DESCRIBE failed, parse failed, zero columns). */
  reason: string;
  /**
   * Whether the failure should degrade rather than fail the build. True for any
   * DESCRIBE that never ran (connectivity, auth/permission, SDK/config) — the
   * has-types gate reuses committed types. False for the deny-list of
   * deterministic client errors (bad warehouse id 404, malformed request 400)
   * and ran-and-failed responses (unparseable payload, zero columns).
   */
  transient: boolean;
}

/**
 * Result shape from syncMetrics: the schemas (one per entry, possibly empty
 * if the entry failed) plus a list of per-entry failures.
 */
export interface MetricSyncResult {
  schemas: MetricSchema[];
  failures: MetricSyncFailure[];
}
