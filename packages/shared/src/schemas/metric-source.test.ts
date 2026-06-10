import { describe, expect, test } from "vitest";
import { metricSourceSchema } from "./metric-source";

describe("metricSourceSchema", () => {
  test("accepts a minimal configuration and defaults executor to app_service_principal", () => {
    const config = {
      $schema:
        "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
      metrics: {
        revenue: { source: "appkit_demo.public.revenue_metrics" },
      },
    };
    const result = metricSourceSchema.safeParse(config);
    expect(result.success).toBe(true);
    expect(result.data?.metrics?.revenue.executor).toBe(
      "app_service_principal",
    );
  });

  test("accepts explicit executor values", () => {
    const config = {
      metrics: {
        revenue: {
          source: "demo.public.revenue",
          executor: "app_service_principal",
        },
        my_orders: { source: "main.sales.orders_by_user", executor: "user" },
      },
    };
    const result = metricSourceSchema.safeParse(config);
    expect(result.success).toBe(true);
    expect(result.data?.metrics?.my_orders.executor).toBe("user");
  });

  test("accepts an empty configuration", () => {
    expect(metricSourceSchema.safeParse({}).success).toBe(true);
    expect(metricSourceSchema.safeParse({ metrics: {} }).success).toBe(true);
  });

  test("accepts metric keys with underscores", () => {
    const config = {
      metrics: {
        customer_metrics: { source: "demo.public.customer_metrics" },
      },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(true);
  });

  test("rejects the legacy sp/obo lane shape", () => {
    const config = {
      sp: { revenue: { source: "demo.public.revenue" } },
      obo: { my_orders: { source: "main.sales.orders_by_user" } },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects invalid executor values", () => {
    for (const executor of ["sp", "obo", "service_principal", "USER"]) {
      const config = {
        metrics: { revenue: { source: "a.b.c", executor } },
      };
      expect(metricSourceSchema.safeParse(config).success).toBe(false);
    }
  });

  test("rejects a bare-string entry (must be an object)", () => {
    const config = {
      metrics: { revenue: "demo.public.revenue" },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects an entry without source", () => {
    const config = {
      metrics: { revenue: {} },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects unknown fields on entries", () => {
    const config = {
      metrics: {
        revenue: {
          source: "a.b.c",
          ttl: 5, // future option, not in v1
        },
      },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects unknown top-level keys", () => {
    expect(metricSourceSchema.safeParse({ foo: 1 }).success).toBe(false);
    expect(
      metricSourceSchema.safeParse({ metrics: {}, unknown: {} }).success,
    ).toBe(false);
  });

  test("rejects metric keys that start with a digit", () => {
    const config = {
      metrics: { "1bad": { source: "a.b.c" } },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects metric keys containing a hyphen", () => {
    const config = {
      metrics: { "bad-key": { source: "a.b.c" } },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects a non-three-part FQN", () => {
    const cases = [
      "revenue", // single token
      "demo.revenue", // two parts
      "four.parts.really.bad",
      ".starts.with.dot",
      "ends.with.dot.",
    ];
    for (const source of cases) {
      const config = { metrics: { revenue: { source } } };
      expect(metricSourceSchema.safeParse(config).success).toBe(false);
    }
  });
});
