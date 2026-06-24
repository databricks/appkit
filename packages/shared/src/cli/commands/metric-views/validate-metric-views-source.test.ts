import { describe, expect, test } from "vitest";
import {
  formatMetricViewsPath,
  formatMetricViewsSourceErrors,
  validateMetricViewsSource,
} from "./validate-metric-views-source";

/**
 * Fixtures are derived from the ACTUAL canonical schema
 * (`packages/shared/src/schemas/metric-source.ts`) and the UC FQN grammar
 * (`packages/shared/src/schemas/metric-fqn.ts`):
 *  - FQN: exactly three dot-separated segments; each segment may contain any
 *    character EXCEPT ASCII control chars (U+0000-U+001F), space (U+0020),
 *    forward slash, period, or DELETE (U+007F). Non-ASCII letters and hyphens
 *    are explicitly legal.
 *  - executor: enum "app_service_principal" (default) | "user".
 *  - metric key (record key): /^[a-zA-Z_][a-zA-Z0-9_]*$/.
 *  - root + entry objects are .strict() — unknown keys are rejected.
 */

describe("validateMetricViewsSource", () => {
  describe("accepts", () => {
    test("a valid three-part FQN with the default executor", () => {
      const result = validateMetricViewsSource({
        metricViews: {
          revenue: { source: "main.analytics.customer_metrics" },
        },
      });
      expect(result.valid).toBe(true);
    });

    test('executor: "user"', () => {
      const result = validateMetricViewsSource({
        metricViews: {
          revenue: { source: "main.analytics.cm", executor: "user" },
        },
      });
      expect(result.valid).toBe(true);
    });

    test('executor: "app_service_principal"', () => {
      const result = validateMetricViewsSource({
        metricViews: {
          revenue: {
            source: "main.analytics.cm",
            executor: "app_service_principal",
          },
        },
      });
      expect(result.valid).toBe(true);
    });

    test("FQN segments with non-ASCII letters and hyphens (UC delimited-identifier grammar)", () => {
      const result = validateMetricViewsSource({
        metricViews: {
          // café (combining acute), prod-data (hyphen), métricas (non-ASCII).
          rev: { source: "café.prod-data.métricas" },
        },
      });
      expect(result.valid).toBe(true);
    });

    test("a $schema key alongside metricViews", () => {
      const result = validateMetricViewsSource({
        $schema:
          "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
        metricViews: { revenue: { source: "main.a.cm" } },
      });
      expect(result.valid).toBe(true);
    });

    test("an empty metricViews map", () => {
      const result = validateMetricViewsSource({ metricViews: {} });
      expect(result.valid).toBe(true);
    });

    test("a completely empty object (metricViews is optional)", () => {
      const result = validateMetricViewsSource({});
      expect(result.valid).toBe(true);
    });
  });

  describe("rejects", () => {
    test("an FQN segment containing a space", () => {
      const result = validateMetricViewsSource({
        metricViews: { rev: { source: "main.bad name.cm" } },
      });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe("metricViews.rev.source");
    });

    test("an FQN segment containing a forward slash", () => {
      const result = validateMetricViewsSource({
        metricViews: { rev: { source: "main.a/b.cm" } },
      });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      expect(result.errors[0].path).toBe("metricViews.rev.source");
    });

    test("a two-part FQN (a literal dot inside what should be one segment)", () => {
      const result = validateMetricViewsSource({
        metricViews: { rev: { source: "main.cm" } },
      });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      expect(result.errors[0].path).toBe("metricViews.rev.source");
    });

    test("an unknown executor value", () => {
      const result = validateMetricViewsSource({
        metricViews: { rev: { source: "main.a.cm", executor: "robot" } },
      });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      expect(result.errors[0].path).toBe("metricViews.rev.executor");
    });

    test("an unknown entry key (entries are .strict())", () => {
      const result = validateMetricViewsSource({
        metricViews: { rev: { source: "main.a.cm", ttl: 5 } },
      });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      // Unrecognized-keys issues attach to the containing object.
      expect(result.errors[0].path).toBe("metricViews.rev");
      expect(result.errors[0].message.toLowerCase()).toContain("ttl");
    });

    test("a metric key that is not a valid identifier", () => {
      const result = validateMetricViewsSource({
        metricViews: { "1bad": { source: "main.a.cm" } },
      });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      expect(result.errors[0].path).toBe("metricViews.1bad");
    });

    test("an unknown top-level key (root is .strict())", () => {
      const result = validateMetricViewsSource({
        metricViews: {},
        unexpected: true,
      });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      // Root-level issues render as "(root)".
      expect(result.errors[0].path).toBe("(root)");
    });
  });
});

describe("formatMetricViewsPath", () => {
  test("empty path renders as (root)", () => {
    expect(formatMetricViewsPath([])).toBe("(root)");
    expect(formatMetricViewsPath(undefined)).toBe("(root)");
  });

  test("nested object keys join with dots", () => {
    expect(formatMetricViewsPath(["metricViews", "revenue", "source"])).toBe(
      "metricViews.revenue.source",
    );
  });

  test("numeric segments render as bracket indices", () => {
    expect(formatMetricViewsPath(["a", 0, "b"])).toBe("a[0].b");
  });
});

describe("formatMetricViewsSourceErrors", () => {
  test("renders each issue as an indented `path: message` line", () => {
    const out = formatMetricViewsSourceErrors([
      { path: "metricViews.revenue.source", message: "Invalid string" },
      { path: "(root)", message: 'Unrecognized key: "foo"' },
    ]);
    expect(out).toBe(
      '  metricViews.revenue.source: Invalid string\n  (root): Unrecognized key: "foo"',
    );
  });

  test("an empty issue list renders as an empty string", () => {
    expect(formatMetricViewsSourceErrors([])).toBe("");
  });
});
