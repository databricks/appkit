/** Max number of values allowed in an `in.(…)` list. */
export const IN_CAP = 100;
/** Hard ceiling for a runtime query limit. */
export const MAX_LIMIT = 500;
/** Default page size when no `.limit()` is supplied. */
export const DEFAULT_LIMIT = 50;
/** Max number of relations resolvable in a single `.include()`. */
export const MAX_INCLUDES = 10;

/** Scalar values accepted by primary-key operations. */
export type IdValue = string | number | bigint;
/** Ordering accepted by typed clients and the runtime adapter. */
export type OrderDirection = "asc" | "desc";

/** Filter operators usable in the runtime WHERE translator and the `where` spec type. */
export const FILTER_OPERATORS = Object.freeze([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "in",
  "is",
] as const);

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export function isFilterOperator(token: string): token is FilterOperator {
  return (FILTER_OPERATORS as readonly string[]).includes(token);
}
