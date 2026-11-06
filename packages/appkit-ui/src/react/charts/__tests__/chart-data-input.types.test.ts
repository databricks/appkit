import { describe, expectTypeOf, test } from "vitest";

import type { BarChartProps, ChartDataInput, ChartRow } from "../types";

// A pure data module, typed with an interface (no index signature) and kept
// readonly: it must be usable as chart data without refactoring.
interface Trip {
  day: string;
  trips: number;
}
const trips: readonly Trip[] = [
  { day: "Mon", trips: 12 },
  { day: "Tue", trips: 19 },
] as const;

describe("chart data input types", () => {
  test("interface-typed and readonly rows are valid chart data", () => {
    expectTypeOf(trips).toMatchTypeOf<ChartDataInput>();
    expectTypeOf<{ data: readonly Trip[] }>().toMatchTypeOf<
      Pick<Extract<BarChartProps, { data: unknown }>, "data">
    >();
  });

  test("ChartRow has an index signature for annotating data modules", () => {
    const rows: ChartRow[] = [{ day: "Mon", trips: 12 }];
    expectTypeOf(rows[0]).toEqualTypeOf<Record<string, unknown>>();
  });
});
