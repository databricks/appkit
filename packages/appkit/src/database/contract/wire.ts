/** Max number of values allowed in an `in.(…)` list. */
export const IN_CAP = 100;
/** Hard ceiling for a runtime query limit. */
export const MAX_LIMIT = 500;
/** Hard ceiling for a runtime query offset. OFFSET scans are unbounded in cost. */
export const MAX_OFFSET = 10_000;
/** Default page size when no `.limit()` is supplied. */
export const DEFAULT_LIMIT = 50;
/** Max number of relations resolvable in a single `.include()`. */
export const MAX_INCLUDES = 10;
/** Max nesting depth of `and`/`or` groups in one runtime predicate. */
export const MAX_WHERE_DEPTH = 5;
/** Max members accepted by one runtime `and`/`or` group. */
export const MAX_WHERE_GROUP_ITEMS = 20;
/** Max column conditions accepted across one runtime predicate tree. */
export const MAX_WHERE_CONDITIONS = 50;
/** Max number of relation edges one include path may traverse. */
export const MAX_INCLUDE_DEPTH = 2;
/** Max number of relation nodes across a complete include tree. */
export const MAX_INCLUDE_NODES = 25;

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
