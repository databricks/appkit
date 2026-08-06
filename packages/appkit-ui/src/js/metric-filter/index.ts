import type { MetricFilter, MetricPredicate } from "shared";

export type {
  MetricFilter,
  MetricFilterOperatorName,
  MetricPredicate,
} from "shared";

/**
 * Shorthand map of `dimension -> selected value(s)` that {@link toMetricFilter}
 * compiles into a {@link MetricFilter}. A member is dropped when its value is
 * `undefined` or an empty array, so a partially-filled filter-bar selection maps
 * straight to "no predicate for that dimension".
 *
 * `null` is meaningful and distinct from `undefined`: it selects the rows whose
 * dimension **is** NULL, compiling to the grammar's `notSet` (`IS NULL`). This
 * matters because a NULL group key stringifies to the literal `"null"`, which as
 * an `equals` value would match no row at all.
 */
export type MetricFilterShorthand = Record<
  string,
  string | number | null | ReadonlyArray<string | number> | undefined
>;

/**
 * Compile a `{ dimension -> value(s) }` shorthand into a {@link MetricFilter} —
 * the equality/membership case a filter bar, dropdown set, or clicked data point
 * produces. Scalar values become an `equals` predicate; array values become an
 * `in` predicate; `null` becomes a `notSet` (`IS NULL`) predicate. Members with
 * `undefined` or empty-array values are omitted.
 *
 * Note the `null` / `undefined` asymmetry: `undefined` means "no filter on this
 * dimension", while `null` means "filter to the rows where it IS NULL". Passing
 * a stringified NULL (`String(null)` → `"null"`) instead would compile to
 * `equals 'null'` and silently match nothing, so pass the real `null` through.
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
 *
 * toMetricFilter({ region: null });
 * // → { member: "region", operator: "notSet" }
 * ```
 */
export function toMetricFilter(
  selection: MetricFilterShorthand,
): MetricFilter | undefined {
  const predicates: MetricPredicate[] = [];
  for (const member of Object.keys(selection)) {
    const value = selection[member];
    if (value === undefined) continue;
    if (value === null) {
      // `notSet` renders `IS NULL` and takes no values.
      predicates.push({ member, operator: "notSet" });
    } else if (Array.isArray(value)) {
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
