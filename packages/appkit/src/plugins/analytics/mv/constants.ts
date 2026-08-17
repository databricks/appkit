import type { MetricFilterOperatorName, MetricOrderDirection } from "shared";

import { METRIC_CONFIG_FILE } from "../../../../../shared/src/schemas/metric-fqn";
import type { MetricLane } from "../types";

// Re-exported from the shared zod-free module (single source of truth for the
// `definitions.json` basename) so analytics-local callers keep importing it
// from this barrel.
export { METRIC_CONFIG_FILE };

/** Runtime vocabulary accepted by the analytics metric-view validator. */
export const METRIC_FILTER_OPERATORS = [
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "in",
  "notIn",
  "set",
  "notSet",
] as const satisfies readonly MetricFilterOperatorName[];

/** Operators that require at least one value. */
export const LIST_VALUE_OPERATORS = new Set<MetricFilterOperatorName>([
  "in",
  "notIn",
]);

/** Operators that reject `values` entirely. */
export const NULL_OPERATORS = new Set<MetricFilterOperatorName>([
  "set",
  "notSet",
]);

/** Operators that emit `LIKE` / `NOT LIKE` and require a string value. */
export const STRING_OPERATORS = new Set<MetricFilterOperatorName>([
  "contains",
  "notContains",
]);

/** Operators that require exactly one value. */
export const SINGLE_VALUE_OPERATORS = new Set<MetricFilterOperatorName>([
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  ...STRING_OPERATORS,
]);

/** Runtime vocabulary accepted by the metric-view `orderBy` validator. */
export const METRIC_ORDER_DIRECTIONS = [
  "ASC",
  "DESC",
] as const satisfies readonly MetricOrderDirection[];

/**
 * Measure, dimension, and filter-member names are **column identifiers**: they
 * are validated by the shared {@link isValidColumnName} (rejects only control
 * characters / newlines) and backtick-quoted via {@link quoteIdentifier} at
 * every interpolation point.
 *
 * Time-grain token shape. Unlike the column identifiers above, the grain is
 * interpolated as a single-quoted `date_trunc` unit LITERAL in {@link renderDimensionClause},
 * so it keeps a narrow keyword-shaped gate — that pattern is what keeps a hostile token out
 * of the quoted-literal position.
 */
export const TIME_GRAIN_PATTERN = /^[a-z][a-z_]*$/;

/**
 * The depth count is the number of nested `{ and }` / `{ or }` wrappers
 * encountered while descending; leaf predicates do not count toward depth.
 * Prevents stack-overflowing the recursive validator or translator.
 */
export const METRIC_FILTER_MAX_DEPTH = 8;

/**
 * Cardinality caps on user-controlled arrays.
 * Prevents stack-overflowing the recursive validator or translator.
 */
export const METRIC_MEASURES_MAX = 50;
export const METRIC_DIMENSIONS_MAX = 20;
export const METRIC_FILTER_VALUES_MAX = 1000;
export const METRIC_LIMIT_MAX = 100_000;
/**
 * Cap on the request's `orderBy` array. The rendered clause can exceed this,
 * since a `limit`ed query also appends the unnamed dimensions as tie-breakers —
 * the cap bounds what a caller sends, not the emitted key count.
 */
export const METRIC_ORDER_BY_MAX = 20;

/**
 * Maximum number of children per AND/OR group node.
 * Prevents stack-overflowing the recursive validator or translator.
 */
export const METRIC_FILTER_GROUP_MAX = 100;

/**
 * Map an entry's declared `executor` to the internal execution lane:
 *   - `"user"`                → `"obo"` (per-user cache, on-behalf-of)
 *   - `"app_service_principal"` (default) → `"sp"` (shared cache)
 */
export function laneFromExecutor(
  executor: "app_service_principal" | "user",
): MetricLane {
  return executor === "user" ? "obo" : "sp";
}
