/** The filter-operator vocabulary accepted by the metric-view wire contract. */
export type MetricFilterOperatorName =
  | "equals"
  | "notEquals"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains"
  | "in"
  | "notIn"
  | "set"
  | "notSet";

/** A single filter predicate — the leaf node of the recursive {@link MetricFilter} tree. */
export interface MetricPredicate {
  member: string;
  operator: MetricFilterOperatorName;
  values?: ReadonlyArray<string | number>;
}

export type MetricOrderDirection = "ASC" | "DESC";

/**
 * A single `ORDER BY` key for the metric-view request.
 *
 * `field` must be one of the request's own `measures` or `dimensions` — a
 * measure is ordered by its SELECT **alias**, because `ORDER BY MEASURE(...)` is
 * rejected by Spark (`METRIC_VIEW_INVALID_MEASURE_FUNCTION_INPUT`). `direction`
 * is a closed vocabulary so nothing free-form reaches the SQL string; omitting
 * it means `ASC` (the SQL default).
 *
 * The default `MetricOrderBy` (equivalent to `MetricOrderBy<string>`) is the
 * broad wire/server form. When extracting a reusable `orderBy` array for
 * `useMetricView`, parameterize it with the selected field literals so the hook
 * can verify that every ordering field was selected.
 */
export interface MetricOrderBy<Field extends string = string> {
  field: Field;
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
