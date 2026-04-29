import { describe, expectTypeOf, test } from "vitest";
import type {
  DimensionKey,
  MeasureKey,
  TimeGrain,
  UseMetricViewArgs,
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
