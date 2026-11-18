import { expect, test, vi } from "vitest";

import { compileTypeProbe } from "./type-probe";

// Each probe runs the tsc binary over the package, which can exceed
// Vitest's 5s default on CI's 2-core runners.
vi.setConfig({ testTimeout: 30_000 });

test("useMetricView keeps omitted dimensions out of rows and requires a grain target", () => {
  const diagnostics = compileTypeProbe(
    `
    import { useMetricView } from "../src/react/hooks/use-metric-view";
    import type {
      MetricOrderBy,
      UseMetricViewOptions,
      UseMetricViewResult,
    } from "../src/react/hooks/types";

    declare module "../src/react/hooks/types" {
      interface MetricRegistry {
        revenue: {
          measures: { arr: string | null; mrr: string | null };
          dimensions: { region: string | null; created_at: string | null };
          measureKeys: "arr" | "mrr";
          dimensionKeys: "region" | "created_at";
          timeGrains: "day" | "month";
          metadata: {
            measures: {};
            dimensions: {
              region: { type: "string" };
              created_at: {
                type: "timestamp";
                time_grain: readonly ["day", "month"];
              };
            };
          };
        };
      }
    }

    type MeasureOnlyResult = ReturnType<
      typeof useMetricView<"revenue", readonly ["arr"]>
    >;
    declare const result: MeasureOnlyResult;
    const expected: UseMetricViewResult<Array<{ arr: string | null }>> = result;
    void expected;
    // @ts-expect-error region was not selected
    result.data?.[0]?.region;

    type TimeOptions = UseMetricViewOptions<
      "revenue",
      readonly ["arr"],
      readonly ["created_at"]
    >;
    const valid: TimeOptions = {
      measures: ["arr"],
      dimensions: ["created_at"],
      timeDimension: "created_at",
      timeGrain: "month",
    };
    void valid;

    const reusableOrderBy: ReadonlyArray<MetricOrderBy<"arr" | "created_at">> = [
      { field: "arr", direction: "DESC" },
      { field: "created_at" },
    ];
    const ordered: TimeOptions = {
      measures: ["arr"],
      dimensions: ["created_at"],
      orderBy: reusableOrderBy,
    };
    void ordered;

    const unselectedOrderBy: ReadonlyArray<MetricOrderBy<"mrr">> = [{ field: "mrr" }];
    // @ts-expect-error mrr was not selected
    const invalidOrder: TimeOptions = { measures: ["arr"], dimensions: ["created_at"], orderBy: unselectedOrderBy };
    void invalidOrder;

    const broadOrderBy: MetricOrderBy[] = [{ field: "arr", direction: "DESC" }];
    // @ts-expect-error MetricOrderBy<string> does not prove that its fields were selected
    const broadOrder: TimeOptions = { measures: ["arr"], dimensions: ["created_at"], orderBy: broadOrderBy };
    void broadOrder;

    // @ts-expect-error timeGrain requires timeDimension
    const missingTarget: TimeOptions = { measures: ["arr"], dimensions: ["created_at"], timeGrain: "month" };
    void missingTarget;

    type NoDimensionOptions = UseMetricViewOptions<
      "revenue",
      readonly ["arr"],
      readonly []
    >;
    // @ts-expect-error timeDimension must be selected in dimensions
    const unselectedTarget: NoDimensionOptions = { measures: ["arr"], timeDimension: "created_at", timeGrain: "month" };
    void unselectedTarget;
  `,
    { types: ["vite/client"] },
  );

  expect(diagnostics).toEqual([]);
});
