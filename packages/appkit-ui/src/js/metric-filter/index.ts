// ────────────────────────────────────────────────────────────────────────────
// Metric filter vocabulary + builder.
//
// Pure, framework-agnostic. Lives on the `/js` axis because a `MetricFilter` is
// plain data — a Node script, an SSR pass, or a test can build one without React
// in the graph. The React `useMetricView` hook re-exports these types from
// `@databricks/appkit-ui/react` so its public surface is unchanged.
//
// **Kept in sync with appkit `plugins/analytics/types.ts`** — appkit-ui cannot
// depend on appkit, so this mirrors the twelve-operator filter grammar by hand.
// ────────────────────────────────────────────────────────────────────────────

/** v1 filter operator vocabulary — exactly twelve names. */
export type MetricFilterOperatorName =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains"
  | "set"
  | "notSet";

/** A single filter predicate — the leaf node of the recursive {@link MetricFilter} tree. */
export interface MetricPredicate {
  member: string;
  operator: MetricFilterOperatorName;
  values?: ReadonlyArray<string | number>;
}

/** Recursive filter expression: a leaf {@link MetricPredicate} or an `and`/`or` group. */
export type MetricFilter =
  | MetricPredicate
  | { and: ReadonlyArray<MetricFilter> }
  | { or: ReadonlyArray<MetricFilter> };

/**
 * Shorthand map of `dimension -> selected value(s)` that {@link toMetricFilter}
 * compiles into a {@link MetricFilter}. A member is dropped when its value is
 * `undefined` or an empty array, so a partially-filled filter-bar selection maps
 * straight to "no predicate for that dimension".
 */
export type MetricFilterShorthand = Record<
  string,
  string | number | ReadonlyArray<string | number> | undefined
>;

/**
 * Compile a `{ dimension -> value(s) }` shorthand into a {@link MetricFilter} —
 * the equality/membership case a filter bar, dropdown set, or clicked data point
 * produces. Scalar values become an `equals` predicate; array values become an
 * `in` predicate. Members with `undefined` or empty-array values are omitted.
 *
 * Returns a bare {@link MetricPredicate} for a single member, an `and` group for
 * several, and `undefined` when nothing is selected (so the caller can pass it
 * straight to `useMetricView`'s optional `filter`, which omits the field when
 * `undefined`). For operators beyond equality/membership (ranges, `contains`,
 * `set`), build the {@link MetricFilter} tree directly.
 *
 * @example
 * ```typescript
 * toMetricFilter({ region: "EMEA" });
 * // → { member: "region", operator: "equals", values: ["EMEA"] }
 *
 * toMetricFilter({ region: ["EMEA", "APAC"], segment: "SMB" });
 * // → { and: [
 * //     { member: "region", operator: "in", values: ["EMEA", "APAC"] },
 * //     { member: "segment", operator: "equals", values: ["SMB"] },
 * //   ] }
 *
 * toMetricFilter({ region: undefined }); // → undefined
 * ```
 */
export function toMetricFilter(
  selection: MetricFilterShorthand,
): MetricFilter | undefined {
  const predicates: MetricPredicate[] = [];
  for (const member of Object.keys(selection)) {
    const value = selection[member];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      predicates.push({ member, operator: "in", values: [...value] });
    } else {
      predicates.push({
        member,
        operator: "equals",
        values: [value as string | number],
      });
    }
  }
  if (predicates.length === 0) return undefined;
  if (predicates.length === 1) return predicates[0];
  return { and: predicates };
}
