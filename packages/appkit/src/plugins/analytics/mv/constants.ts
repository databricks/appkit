import path from "node:path";
import type { MetricFilterOperatorName, MetricLane } from "../types";

/**
 * Default queries directory. Mirrors `AppManager`'s
 * `path.resolve(process.cwd(), "config/queries")` so dev mode and production
 * share a single source of truth for where metric config lives. Exported so
 * `AnalyticsPlugin` can default `config.queriesDir` to the same path.
 */
export const QUERIES_DIR = path.resolve(process.cwd(), "config/queries");
export const METRIC_CONFIG_FILE = "metric-views.json";

/**
 * Measure, dimension, and filter-member names are **column identifiers**: they
 * are validated by the shared {@link isValidColumnName} (rejects only control
 * characters / newlines) and backtick-quoted via {@link quoteIdentifier} at
 * every interpolation point. Quoting — not a narrow ASCII allowlist — is the
 * injection boundary, so the runtime accepts the full delimited-identifier
 * grammar the type-generator emits from DESCRIBE (hyphens, dots, non-ASCII).
 * There is deliberately NO name allowlist: a well-formed-but-unknown column
 * falls through to the warehouse and surfaces as a sanitized canonical error.
 *
 * Time-grain token shape. Unlike the column identifiers above, the grain is
 * interpolated as a single-quoted `date_trunc` unit LITERAL (NOT a bind param,
 * NOT a delimited identifier) in {@link renderDimensionClause}, so it keeps a
 * narrow keyword-shaped gate — that pattern is what keeps a hostile token out
 * of the quoted-literal position.
 */
export const TIME_GRAIN_PATTERN = /^[a-z][a-z_]*$/;

/**
 * Maximum AND/OR nesting depth. The PRD documents 8 as a sensible cap —
 * enough for any real BI filter UI, low enough that a hostile or malformed
 * payload cannot stack-overflow the recursive validator or translator.
 *
 * The depth count is the number of nested `{ and }` / `{ or }` wrappers
 * encountered while descending — leaf predicates do not count toward depth.
 */
export const METRIC_FILTER_MAX_DEPTH = 8;

/**
 * Cardinality caps on user-controlled arrays. Closes the recurring
 * `unbounded-request-parameters` finding: a hostile caller could otherwise
 * send `values: [...10M items...]` and exhaust the validator + the named
 * bind-var binding step. The limits below are deliberately generous — higher
 * than any real BI UI would emit — so legitimate traffic never trips them.
 */
export const METRIC_MEASURES_MAX = 50;
export const METRIC_DIMENSIONS_MAX = 20;
export const METRIC_FILTER_VALUES_MAX = 1000;
export const METRIC_LIMIT_MAX = 100_000;

/**
 * Maximum number of children per AND/OR group node. Without this cap a single
 * flat group like `{ and: [...10M empty objects...] }` would push tens of
 * millions of frames onto the iterative pre-check's stack — OOM before
 * validation even gets to Zod. The Zod schema enforces the same cap so the
 * rejection point is consistent regardless of which validator catches it
 * first.
 */
export const METRIC_FILTER_GROUP_MAX = 100;

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

/**
 * The exact twelve filter operators allowed at v1. The runtime tuple is the
 * server-side source of truth; the client-side type union
 * `MetricFilterOperatorName` mirrors these names statically.
 */
export const METRIC_FILTER_OPERATORS = [
  ...SINGLE_VALUE_OPERATORS,
  ...LIST_VALUE_OPERATORS,
  ...NULL_OPERATORS,
] as const satisfies readonly MetricFilterOperatorName[];
