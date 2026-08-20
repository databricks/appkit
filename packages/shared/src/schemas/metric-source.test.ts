import { describe, expect, test } from "vitest";

import { metricSourceSchema } from "./metric-source";

describe("metricSourceSchema", () => {
  test("accepts a minimal configuration and defaults executor to app_service_principal", () => {
    const config = {
      $schema:
        "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
      metricViews: {
        revenue: { source: "appkit_demo.public.revenue_metrics" },
      },
    };
    const result = metricSourceSchema.safeParse(config);
    expect(result.success).toBe(true);
    expect(result.data?.metricViews?.revenue.executor).toBe(
      "app_service_principal",
    );
  });

  test("accepts explicit executor values", () => {
    const config = {
      metricViews: {
        revenue: {
          source: "demo.public.revenue",
          executor: "app_service_principal",
        },
        my_orders: { source: "main.sales.orders_by_user", executor: "user" },
      },
    };
    const result = metricSourceSchema.safeParse(config);
    expect(result.success).toBe(true);
    expect(result.data?.metricViews?.my_orders.executor).toBe("user");
  });

  test("accepts an empty configuration", () => {
    expect(metricSourceSchema.safeParse({}).success).toBe(true);
    expect(metricSourceSchema.safeParse({ metricViews: {} }).success).toBe(
      true,
    );
  });

  test("accepts metric keys with underscores", () => {
    const config = {
      metricViews: {
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
        metricViews: { revenue: { source: "a.b.c", executor } },
      };
      expect(metricSourceSchema.safeParse(config).success).toBe(false);
    }
  });

  test("rejects a bare-string entry (must be an object)", () => {
    const config = {
      metricViews: { revenue: "demo.public.revenue" },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects an entry without source", () => {
    const config = {
      metricViews: { revenue: {} },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects unknown fields on entries", () => {
    const config = {
      metricViews: {
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
      metricSourceSchema.safeParse({ metricViews: {}, unknown: {} }).success,
    ).toBe(false);
  });

  test("rejects metric keys that start with a digit", () => {
    const config = {
      metricViews: { "1bad": { source: "a.b.c" } },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects metric keys containing a hyphen", () => {
    const config = {
      metricViews: { "bad-key": { source: "a.b.c" } },
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
      const config = { metricViews: { revenue: { source } } };
      expect(metricSourceSchema.safeParse(config).success).toBe(false);
    }
  });
});
