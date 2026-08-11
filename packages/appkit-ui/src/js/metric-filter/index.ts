import type { MetricFilter, MetricPredicate } from "shared";

export type {
  MetricFilter,
  MetricFilterOperatorName,
  MetricOrderBy,
  MetricOrderDirection,
  MetricPredicate,
} from "shared";

/**
 * Shorthand map of `dimension -> selected value(s)`.
 * A member is dropped when its value is `undefined` or empty array,
 * so a partially-filled filter-bar selection maps straight to "no predicate for that dimension".
 *
 */
export type MetricFilterShorthand = Record<
  string,
  string | number | null | ReadonlyArray<string | number> | undefined
>;

/**
 * Compile a `{ dimension -> value(s) }` shorthand into a {@link MetricFilter}
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
