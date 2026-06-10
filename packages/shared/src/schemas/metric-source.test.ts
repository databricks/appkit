import { describe, expect, test } from "vitest";
import { metricSourceSchema } from "./metric-source";

describe("metricSourceSchema", () => {
  test("accepts a valid SP-only configuration", () => {
    const config = {
      $schema:
        "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
      sp: {
        revenue: { source: "appkit_demo.public.revenue_metrics" },
      },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(true);
  });

  test("accepts mixed sp + obo lanes", () => {
    const config = {
      sp: { revenue: { source: "demo.public.revenue" } },
      obo: { customer: { source: "demo.public.customer_metrics" } },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(true);
  });

  test("accepts an empty configuration", () => {
    expect(metricSourceSchema.safeParse({}).success).toBe(true);
    expect(metricSourceSchema.safeParse({ sp: {}, obo: {} }).success).toBe(
      true,
    );
  });

  test("accepts metric keys with underscores", () => {
    const config = {
      sp: { customer_metrics: { source: "demo.public.customer_metrics" } },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(true);
  });

  test("rejects a bare-string entry (must be an object)", () => {
    const config = {
      sp: { revenue: "demo.public.revenue" },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects an entry without source", () => {
    const config = {
      sp: { revenue: {} },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects unknown fields on entries", () => {
    const config = {
      sp: {
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
      metricSourceSchema.safeParse({ sp: {}, obo: {}, unknown: {} }).success,
    ).toBe(false);
  });

  test("rejects metric keys that start with a digit", () => {
    const config = {
      sp: { "1bad": { source: "a.b.c" } },
    };
    expect(metricSourceSchema.safeParse(config).success).toBe(false);
  });

  test("rejects metric keys containing a hyphen", () => {
    const config = {
      sp: { "bad-key": { source: "a.b.c" } },
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
      const config = { sp: { revenue: { source } } };
      expect(metricSourceSchema.safeParse(config).success).toBe(false);
    }
  });
});
