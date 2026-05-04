import { afterEach, describe, expect, test } from "vitest";
import {
  _getRegisteredBundleForTesting,
  clearMetricsMetadata,
  getMetricMetadata,
  registerMetricsMetadata,
} from "../registry";
import type { MetricsMetadataBundle } from "../types";

afterEach(() => {
  clearMetricsMetadata();
});

const sampleBundle: MetricsMetadataBundle = {
  revenue: {
    measures: {
      arr: {
        type: "DECIMAL(38,2)",
        display_name: "Annual Recurring Revenue",
        format: "$#,##0.00",
      },
    },
    dimensions: {
      region: { type: "STRING" },
    },
  },
  customer_metrics: {
    measures: {
      churn: { type: "DOUBLE", format: "0.0%" },
    },
    dimensions: {
      csm_email: { type: "STRING" },
    },
  },
};

describe("registerMetricsMetadata + getMetricMetadata", () => {
  test("returns null for any key when no bundle has been registered", () => {
    expect(getMetricMetadata("revenue")).toBeNull();
  });

  test("returns the registered metadata for a known metric key", () => {
    registerMetricsMetadata(sampleBundle);
    const metadata = getMetricMetadata("revenue");
    expect(metadata).not.toBeNull();
    expect(metadata?.measures.arr.format).toBe("$#,##0.00");
    expect(metadata?.measures.arr.display_name).toBe(
      "Annual Recurring Revenue",
    );
  });

  test("returns null for an unregistered metric key", () => {
    registerMetricsMetadata(sampleBundle);
    expect(getMetricMetadata("nonexistent")).toBeNull();
  });

  test("returns the same object reference on repeated lookups (stable identity)", () => {
    registerMetricsMetadata(sampleBundle);
    const ref1 = getMetricMetadata("revenue");
    const ref2 = getMetricMetadata("revenue");
    expect(ref1).toBe(ref2);
  });

  test("calling register replaces the previous bundle wholesale", () => {
    registerMetricsMetadata(sampleBundle);
    expect(getMetricMetadata("revenue")).not.toBeNull();

    const newBundle: MetricsMetadataBundle = {
      orders: {
        measures: { count: { type: "BIGINT" } },
        dimensions: {},
      },
    };
    registerMetricsMetadata(newBundle);
    expect(getMetricMetadata("revenue")).toBeNull();
    expect(getMetricMetadata("orders")).not.toBeNull();
  });

  test("registering null clears the bundle", () => {
    registerMetricsMetadata(sampleBundle);
    expect(getMetricMetadata("revenue")).not.toBeNull();
    registerMetricsMetadata(null);
    expect(getMetricMetadata("revenue")).toBeNull();
  });

  test("clearMetricsMetadata resets the registry to unregistered state", () => {
    registerMetricsMetadata(sampleBundle);
    clearMetricsMetadata();
    expect(getMetricMetadata("revenue")).toBeNull();
    expect(_getRegisteredBundleForTesting()).toBeNull();
  });

  test("returns metadata for any registered key regardless of execution lane", () => {
    // Lane is a server-side concern (lives in metric.json) and is not part
    // of the client-facing bundle. The hook returns metadata uniformly for
    // both SP-lane and OBO-lane metrics.
    registerMetricsMetadata(sampleBundle);
    expect(getMetricMetadata("revenue")?.measures.arr.format).toBe("$#,##0.00");
    expect(getMetricMetadata("customer_metrics")?.measures.churn.format).toBe(
      "0.0%",
    );
  });
});
