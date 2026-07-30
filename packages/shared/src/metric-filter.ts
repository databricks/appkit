// Metric-filter vocabulary — the single source of truth for the v1 filter
// grammar, shared by the appkit analytics runtime (validator + SQL renderer)
// and the appkit-ui client (which imports the types only). This module is
// zod-free so any consumer can import it without pulling zod into its graph,
// mirroring the sibling `metric-metadata.ts` contract.

/**
 * The exact twelve filter operators allowed at v1. This runtime tuple is the
 * canonical source: {@link MetricFilterOperatorName} is derived from it, so the
 * type union and the runtime list can never drift apart.
 */
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
] as const;

/**
 * v1 filter operator vocabulary — exactly twelve names, derived from the
 * {@link METRIC_FILTER_OPERATORS} tuple so the union stays in lockstep with the
 * runtime list the validator checks against.
 */
export type MetricFilterOperatorName = (typeof METRIC_FILTER_OPERATORS)[number];

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
 * A single filter predicate — the leaf node of the recursive
 * {@link MetricFilter} tree. `member` is a dimension name (grammar-gated, not
 * allowlisted); `values` is bound through parameterized `:f_<idx>` bind vars
 * and never interpolated into the SQL string.
 */
export interface MetricPredicate {
  member: string;
  operator: MetricFilterOperatorName;
  values?: ReadonlyArray<string | number>;
}

/**
 * Recursive filter expression for the metric-view request body: a leaf
 * {@link MetricPredicate} or an `{ and: [...] }` / `{ or: [...] }` group. The
 * shape is intentionally non-generic server-side — per-metric narrowing (if
 * any) lives client-side.
 */
export type MetricFilter =
  | MetricPredicate
  | { and: ReadonlyArray<MetricFilter> }
  | { or: ReadonlyArray<MetricFilter> };
