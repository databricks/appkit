import { describe, expectTypeOf, test } from "vitest";
import type {
  DimensionKey,
  Filter,
  MeasureKey,
  MetricFilterOperator,
  MetricMetadata,
  MetricSemanticMetadata,
  Predicate,
  TimeGrain,
  UseMetricViewArgs,
  UseMetricViewResult,
  UseMetricViewRow,
} from "../types";

/**
 * Compile-time type tests for useMetricView's narrowing behaviour.
 *
 * These tests use `expectTypeOf` and never invoke the hook at runtime — they
 * verify that the registry-derived helpers (`MeasureKey`, `DimensionKey`,
 * `TimeGrain`, `UseMetricViewRow`) compose correctly when the registry is
 * augmented.
 *
 * The MetricRegistry interface is augmented locally inside this file via
 * module declaration. The augmentation only affects the type universe of
 * this test file; production code is untouched.
 */

declare module "../types" {
  interface MetricRegistry {
    revenue: {
      key: "revenue";
      source: "appkit_demo.public.revenue_metrics";
      lane: "sp";
      measures: { arr: number; mrr: number };
      dimensions: { region: string; segment: string; created_at: string };
      measureKeys: "arr" | "mrr";
      dimensionKeys: "region" | "segment" | "created_at";
      timeGrains: "day" | "month" | "week";
      metadata: {
        measures: {
          arr: {
            type: "DECIMAL(38,2)";
            display_name: "Annual Recurring Revenue";
            format: "$#,##0.00";
          };
          mrr: { type: "DECIMAL(38,2)" };
        };
        dimensions: {
          region: { type: "STRING" };
          segment: { type: "STRING" };
          created_at: {
            type: "TIMESTAMP";
            time_grain: readonly ["day", "month", "week"];
          };
        };
      };
    };
    flat_metric: {
      key: "flat_metric";
      source: "demo.public.flat";
      lane: "sp";
      measures: { count: number };
      dimensions: Record<string, never>;
      measureKeys: "count";
      dimensionKeys: never;
      timeGrains: never;
      metadata: {
        measures: { count: { type: "BIGINT" } };
        dimensions: Record<string, never>;
      };
    };
  }
}

describe("MeasureKey<K> / DimensionKey<K> / TimeGrain<K>", () => {
  test("MeasureKey narrows to the registry's declared measure union", () => {
    expectTypeOf<MeasureKey<"revenue">>().toEqualTypeOf<"arr" | "mrr">();
  });

  test("DimensionKey narrows to the registry's declared dimension union", () => {
    expectTypeOf<DimensionKey<"revenue">>().toEqualTypeOf<
      "region" | "segment" | "created_at"
    >();
  });

  test("TimeGrain narrows to the union of YAML-allowed grains", () => {
    expectTypeOf<TimeGrain<"revenue">>().toEqualTypeOf<
      "day" | "month" | "week"
    >();
  });

  test("DimensionKey is `never` when the registry declares no dimensions", () => {
    expectTypeOf<DimensionKey<"flat_metric">>().toEqualTypeOf<never>();
  });

  test("TimeGrain is `never` when the registry declares no time-typed dims", () => {
    expectTypeOf<TimeGrain<"flat_metric">>().toEqualTypeOf<never>();
  });

  test("TimeGrain falls back to `string` for unregistered keys", () => {
    type DynamicGrain = TimeGrain<string>;
    expectTypeOf<DynamicGrain>().toEqualTypeOf<string>();
  });
});

describe("UseMetricViewArgs<K, M, D> — call-site narrowing", () => {
  test("measures + dimensions tuples preserve literal types under `const` modifiers", () => {
    type Args = UseMetricViewArgs<
      "revenue",
      readonly ["arr"],
      readonly ["region"]
    >;
    expectTypeOf<Args["measures"]>().toEqualTypeOf<readonly ["arr"]>();
    expectTypeOf<Args["dimensions"] | undefined>().toEqualTypeOf<
      readonly ["region"] | undefined
    >();
  });

  test("timeGrain is constrained to TimeGrain<K> when provided", () => {
    type Args = UseMetricViewArgs<
      "revenue",
      readonly ["arr"],
      readonly ["created_at"]
    >;
    expectTypeOf<Args["timeGrain"] | undefined>().toEqualTypeOf<
      "day" | "month" | "week" | undefined
    >();
  });
});

describe("UseMetricViewRow<K, M, D> — row narrowing via Pick", () => {
  test("measures-only call narrows the row to just the chosen measures", () => {
    type Row = UseMetricViewRow<"revenue", readonly ["arr"], readonly []>;
    expectTypeOf<Row>().toEqualTypeOf<{ arr: number }>();
  });

  test("measures + one dimension narrows to the union of both", () => {
    type Row = UseMetricViewRow<
      "revenue",
      readonly ["arr"],
      readonly ["region"]
    >;
    expectTypeOf<Row>().toEqualTypeOf<{ arr: number; region: string }>();
  });

  test("multiple measures + multiple dimensions composes correctly", () => {
    type Row = UseMetricViewRow<
      "revenue",
      readonly ["arr", "mrr"],
      readonly ["region", "created_at"]
    >;
    expectTypeOf<Row>().toEqualTypeOf<{
      arr: number;
      mrr: number;
      region: string;
      created_at: string;
    }>();
  });

  test("dimensions-only call narrows the row to just the dimensions", () => {
    type Row = UseMetricViewRow<"revenue", readonly [], readonly ["segment"]>;
    expectTypeOf<Row>().toEqualTypeOf<{ segment: string }>();
  });
});

describe("Filter<K> / Predicate<K> — recursive shape and registry narrowing", () => {
  test("Predicate.member narrows to DimensionKey<K>", () => {
    type RevenueMember = Predicate<"revenue">["member"];
    expectTypeOf<RevenueMember>().toEqualTypeOf<
      "region" | "segment" | "created_at"
    >();
  });

  test("Predicate.operator narrows to MetricFilterOperator (12 v1 ops)", () => {
    type Op = Predicate<"revenue">["operator"];
    expectTypeOf<Op>().toEqualTypeOf<MetricFilterOperator>();
  });

  test("MetricFilterOperator union has exactly 12 members", () => {
    type Op = MetricFilterOperator;
    // exactness guard: assignability both ways
    expectTypeOf<Op>().toEqualTypeOf<
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
      | "notSet"
    >();
  });

  test("Filter<K> accepts a leaf Predicate", () => {
    const leaf: Filter<"revenue"> = {
      member: "region",
      operator: "equals",
      values: ["EMEA"],
    };
    expectTypeOf(leaf).toMatchTypeOf<Filter<"revenue">>();
  });

  test("Filter<K> accepts an { and: Filter<K>[] } group (recursive)", () => {
    const grouped: Filter<"revenue"> = {
      and: [
        { member: "region", operator: "equals", values: ["EMEA"] },
        { member: "segment", operator: "equals", values: ["Enterprise"] },
      ],
    };
    expectTypeOf(grouped).toMatchTypeOf<Filter<"revenue">>();
  });

  test("Filter<K> accepts an { or: Filter<K>[] } group with nested AND (recursive)", () => {
    const nested: Filter<"revenue"> = {
      or: [
        {
          and: [
            { member: "region", operator: "equals", values: ["EMEA"] },
            { member: "segment", operator: "equals", values: ["Enterprise"] },
          ],
        },
        { member: "region", operator: "equals", values: ["APAC"] },
      ],
    };
    expectTypeOf(nested).toMatchTypeOf<Filter<"revenue">>();
  });

  test("UseMetricViewArgs accepts an optional filter narrowing to DimensionKey<K>", () => {
    type Args = UseMetricViewArgs<
      "revenue",
      readonly ["arr"],
      readonly ["region"]
    >;
    expectTypeOf<Args["filter"]>().toEqualTypeOf<
      Filter<"revenue"> | undefined
    >();
  });

  test("Predicate.member is `never` when the registry declares no dimensions", () => {
    type Member = Predicate<"flat_metric">["member"];
    expectTypeOf<Member>().toEqualTypeOf<never>();
  });
});

// ── Phase 5: MetricMetadata<K> narrows per-metric, hook return shape carries metadata ──
describe("MetricMetadata<K> — Phase 5 metadata narrowing", () => {
  test("MetricMetadata narrows to the registry's metadata shape for registered keys", () => {
    type Meta = MetricMetadata<"revenue">;
    expectTypeOf<
      Meta["measures"]["arr"]["format"]
    >().toEqualTypeOf<"$#,##0.00">();
    expectTypeOf<
      Meta["measures"]["arr"]["display_name"]
    >().toEqualTypeOf<"Annual Recurring Revenue">();
  });

  test("MetricMetadata exposes time_grain literal tuple on time-typed dims", () => {
    type Meta = MetricMetadata<"revenue">;
    expectTypeOf<
      Meta["dimensions"]["created_at"]["time_grain"]
    >().toEqualTypeOf<readonly ["day", "month", "week"]>();
  });

  test("MetricMetadata's measures only contain the metric's own keys (not other metrics')", () => {
    type Meta = MetricMetadata<"revenue">;
    type MeasureKeys = keyof Meta["measures"];
    expectTypeOf<MeasureKeys>().toEqualTypeOf<"arr" | "mrr">();

    type FlatMeta = MetricMetadata<"flat_metric">;
    type FlatKeys = keyof FlatMeta["measures"];
    expectTypeOf<FlatKeys>().toEqualTypeOf<"count">();
  });

  test("MetricMetadata falls back to the structural shape for unregistered keys", () => {
    type Meta = MetricMetadata<string>;
    expectTypeOf<Meta>().toEqualTypeOf<MetricSemanticMetadata>();
  });

  test("UseMetricViewResult carries metadata typed per K", () => {
    type Result = UseMetricViewResult<
      { arr: number },
      MetricMetadata<"revenue">
    >;
    type MetaField = Result["metadata"];
    // metadata is the metric's literal-typed metadata or null.
    expectTypeOf<MetaField>().toEqualTypeOf<MetricMetadata<"revenue"> | null>();
  });
});
