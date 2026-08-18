import type {
  MetricFilter as SharedMetricFilter,
  MetricFilterOperatorName as SharedMetricFilterOperatorName,
  MetricOrderDirection as SharedMetricOrderDirection,
  MetricPredicate as SharedMetricPredicate,
} from "shared";
import { describe, expectTypeOf, test } from "vitest";

import type {
  METRIC_FILTER_OPERATORS,
  METRIC_ORDER_DIRECTIONS,
} from "../mv/constants";
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

  test("keeps runtime vocabularies in exact parity with the shared contract", () => {
    expectTypeOf<SharedMetricFilterOperatorName>().toEqualTypeOf<
      (typeof METRIC_FILTER_OPERATORS)[number]
    >();
    expectTypeOf<SharedMetricOrderDirection>().toEqualTypeOf<
      (typeof METRIC_ORDER_DIRECTIONS)[number]
    >();
  });
});
