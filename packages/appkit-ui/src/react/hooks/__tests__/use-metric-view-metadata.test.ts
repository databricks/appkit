import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearMetricsMetadata,
  type MetricsMetadataBundle,
  registerMetricsMetadata,
} from "@/format";

// Mock connectSSE so the hook's render path doesn't fire a real network call
// (we don't need the data flow here — just metadata reading).
vi.mock("@/js", () => ({
  connectSSE: vi.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  ),
}));

import { useMetricView } from "../use-metric-view";

const REVENUE_BUNDLE: MetricsMetadataBundle = {
  revenue: {
    source: "appkit_demo.public.revenue_metrics",
    lane: "sp",
    measures: {
      arr: {
        type: "DECIMAL(38,2)",
        display_name: "Annual Recurring Revenue",
        format: "$#,##0.00",
      },
      mrr: {
        type: "DECIMAL(38,2)",
        display_name: "Monthly Recurring Revenue",
        format: "$#,##0.00",
      },
    },
    dimensions: {
      region: { type: "STRING", display_name: "Region" },
      created_at: {
        type: "TIMESTAMP",
        display_name: "Period",
        time_grain: ["day", "week", "month"],
      },
    },
  },
  other_metric: {
    source: "demo.public.other",
    lane: "sp",
    measures: { count: { type: "BIGINT" } },
    dimensions: {},
  },
};

describe("useMetricView — Phase 5 metadata return field", () => {
  afterEach(() => {
    clearMetricsMetadata();
    vi.clearAllMocks();
  });

  test("metadata is null when no bundle has been registered", () => {
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );
    expect(result.current.metadata).toBeNull();
  });

  test("metadata returns the per-metric subset when registered", () => {
    registerMetricsMetadata(REVENUE_BUNDLE);
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );
    expect(result.current.metadata).not.toBeNull();
    expect(result.current.metadata?.measures.arr.format).toBe("$#,##0.00");
    expect(result.current.metadata?.measures.arr.display_name).toBe(
      "Annual Recurring Revenue",
    );
  });

  test("metadata excludes other metrics in the same bundle", () => {
    registerMetricsMetadata(REVENUE_BUNDLE);
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );
    const meta = result.current.metadata;
    expect(meta).not.toBeNull();
    // The metadata is the revenue entry only — `other_metric` is not nested in.
    expect(Object.keys(meta?.measures ?? {})).toEqual(["arr", "mrr"]);
    // No "other_metric" key leaks through.
    expect(
      (meta as unknown as Record<string, unknown>).other_metric,
    ).toBeUndefined();
  });

  test("metadata is available immediately on first render (before data resolves)", () => {
    registerMetricsMetadata(REVENUE_BUNDLE);
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );
    // PRD contract: metadata is build-time-bundled, not fetched, so it's
    // available even when the data is still loading.
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.metadata).not.toBeNull();
  });

  test("metadata is stable across re-renders for the same metric key", () => {
    registerMetricsMetadata(REVENUE_BUNDLE);
    const { result, rerender } = renderHook(
      ({ measures }) =>
        useMetricView("revenue", { measures } as { measures: ["arr" | "mrr"] }),
      {
        initialProps: { measures: ["arr"] as ["arr" | "mrr"] },
      },
    );

    const firstRef = result.current.metadata;
    rerender({ measures: ["mrr"] });
    const secondRef = result.current.metadata;
    rerender({ measures: ["arr"] });
    const thirdRef = result.current.metadata;

    // Same metric key → same metadata reference across re-renders, regardless
    // of how `args` changes.
    expect(firstRef).toBe(secondRef);
    expect(firstRef).toBe(thirdRef);
  });

  test("metadata changes when the metric key changes", () => {
    registerMetricsMetadata(REVENUE_BUNDLE);
    // The cast escapes the cross-file MetricRegistry augmentation that the
    // sibling type-tests file declares — those augmentations leak into the
    // global type universe of the test project, but we want this hook test to
    // exercise the runtime metadata-resolution logic with synthetic keys.
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) =>
        useMetricView(key as never, { measures: ["count"] } as never),
      {
        initialProps: { key: "revenue" },
      },
    );

    const revenueMetadata = result.current.metadata as unknown as {
      source: string;
    } | null;
    rerender({ key: "other_metric" });
    const otherMetadata = result.current.metadata as unknown as {
      source: string;
    } | null;

    expect(revenueMetadata).not.toBe(otherMetadata);
    expect(revenueMetadata?.source).toBe("appkit_demo.public.revenue_metrics");
    expect(otherMetadata?.source).toBe("demo.public.other");
  });

  test("metadata is null when the metric key is not in the registered bundle", () => {
    registerMetricsMetadata(REVENUE_BUNDLE);
    const { result } = renderHook(() =>
      // Deliberate test of runtime fallback when the metric key is missing
      // from the registered bundle. The cast escapes the augmented-registry
      // type narrowing — the runtime semantics are what matter here.
      useMetricView("not_in_bundle" as never, { measures: ["x"] } as never),
    );
    expect(result.current.metadata).toBeNull();
  });

  test("metadata exposes time_grain on time-typed dimensions", () => {
    registerMetricsMetadata(REVENUE_BUNDLE);
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );
    // The cross-file MetricRegistry augmentation narrows the dimensions
    // shape, so we read it back as the structural metadata type to inspect
    // runtime values.
    const dims = (result.current.metadata?.dimensions ?? {}) as Record<
      string,
      { time_grain?: readonly string[] }
    >;
    expect(dims.created_at?.time_grain).toEqual(["day", "week", "month"]);
    expect(dims.region?.time_grain).toBeUndefined();
  });

  test("metadata reference is stable when bundle is re-registered with the same metric key (PRD's stable-not-reactive contract)", () => {
    registerMetricsMetadata(REVENUE_BUNDLE);
    const { result, rerender } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );
    const firstRef = result.current.metadata;
    expect(firstRef).not.toBeNull();

    // Re-register a new bundle with the same key but different data. The
    // hook is intentionally NOT reactive to bundle changes — the PRD says
    // metadata is build-time-frozen and stable for the lifetime of a metric
    // key. Re-registration during a session is a dev-mode hot-reload signal
    // that requires a remount to pick up; mid-render swaps would break the
    // "stable across re-renders" contract that downstream memoization
    // depends on.
    const newBundle: MetricsMetadataBundle = {
      revenue: {
        source: "demo.public.new_revenue",
        lane: "sp",
        measures: { arr: { type: "DECIMAL", format: "0.00" } },
        dimensions: {},
      },
    };
    registerMetricsMetadata(newBundle);
    rerender();
    const refAfterRegister = result.current.metadata;
    // Same reference — useMemo keys on metricKey, so within a single mount
    // the hook returns the originally-resolved metadata until a remount.
    expect(refAfterRegister).toBe(firstRef);
  });
});
