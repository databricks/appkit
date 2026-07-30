import type {
  MetricFilter as SharedMetricFilter,
  MetricFilterOperatorName as SharedMetricFilterOperatorName,
  MetricPredicate as SharedMetricPredicate,
} from "shared";
import { describe, expectTypeOf, test } from "vitest";
import type {
  MetricFilter,
  MetricFilterOperatorName,
  MetricPredicate,
} from "../types";

describe("analytics metric-filter types", () => {
  test("re-exports the shared AST types", () => {
    expectTypeOf<MetricFilter>().toEqualTypeOf<SharedMetricFilter>();
    expectTypeOf<MetricFilterOperatorName>().toEqualTypeOf<SharedMetricFilterOperatorName>();
    expectTypeOf<MetricPredicate>().toEqualTypeOf<SharedMetricPredicate>();
  });
});
