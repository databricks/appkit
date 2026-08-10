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

export type MetricFilterOperatorName = (typeof METRIC_FILTER_OPERATORS)[number];

export const LIST_VALUE_OPERATORS = new Set<MetricFilterOperatorName>([
  "in",
  "notIn",
]);

export const NULL_OPERATORS = new Set<MetricFilterOperatorName>([
  "set",
  "notSet",
]);

export const STRING_OPERATORS = new Set<MetricFilterOperatorName>([
  "contains",
  "notContains",
]);

export const SINGLE_VALUE_OPERATORS = new Set<MetricFilterOperatorName>([
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  ...STRING_OPERATORS,
]);

/** A single filter predicate — the leaf node of the recursive {@link MetricFilter} tree. */
export interface MetricPredicate {
  member: string;
  operator: MetricFilterOperatorName;
  values?: ReadonlyArray<string | number>;
}

export const METRIC_ORDER_DIRECTIONS = ["ASC", "DESC"] as const;

export type MetricOrderDirection = (typeof METRIC_ORDER_DIRECTIONS)[number];

/**
 * A single `ORDER BY` key for the metric-view request.
 *
 * `field` must be one of the request's own `measures` or `dimensions` — a
 * measure is ordered by its SELECT **alias**, because `ORDER BY MEASURE(...)` is
 * rejected by Spark (`METRIC_VIEW_INVALID_MEASURE_FUNCTION_INPUT`). `direction`
 * is a closed vocabulary so nothing free-form reaches the SQL string; omitting
 * it means `ASC` (the SQL default).
 */
export interface MetricOrderBy {
  field: string;
  direction?: MetricOrderDirection;
}

/**
 * Recursive filter expression for the metric-view request body: a leaf
 * {@link MetricPredicate} or an `{ and: [...] }` / `{ or: [...] }` group.
 */
export type MetricFilter =
  | MetricPredicate
  | { and: ReadonlyArray<MetricFilter> }
  | { or: ReadonlyArray<MetricFilter> };
