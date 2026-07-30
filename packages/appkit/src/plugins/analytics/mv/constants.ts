import { METRIC_CONFIG_FILE } from "../../../../../shared/src/schemas/metric-fqn";
import type { MetricLane } from "../types";

// Re-exported from the shared zod-free module (single source of truth for the
// `definitions.json` basename) so analytics-local callers keep importing it
// from this barrel.
export { METRIC_CONFIG_FILE };

// The filter-operator vocabulary lives canonically in the shared zod-free
// module (single source of truth for both the runtime tuple and the derived
// type union). Re-exported here so analytics-local callers (`schemas.ts`,
// `formatters.ts`) keep importing operators + subsets from this barrel.
export {
  LIST_VALUE_OPERATORS,
  METRIC_FILTER_OPERATORS,
  NULL_OPERATORS,
  SINGLE_VALUE_OPERATORS,
  STRING_OPERATORS,
} from "shared";

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
