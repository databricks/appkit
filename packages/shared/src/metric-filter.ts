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

/**
 * Recursive filter expression for the metric-view request body: a leaf
 * {@link MetricPredicate} or an `{ and: [...] }` / `{ or: [...] }` group.
 */
export type MetricFilter =
  | MetricPredicate
  | { and: ReadonlyArray<MetricFilter> }
  | { or: ReadonlyArray<MetricFilter> };
