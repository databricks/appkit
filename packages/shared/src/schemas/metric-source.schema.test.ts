import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "metric-source.schema.json");

function loadValidator() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("metric-source.schema.json", () => {
  const validate = loadValidator();

  test("accepts a valid SP-only configuration", () => {
    const config = {
      $schema:
        "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
      sp: {
        revenue: { source: "appkit_demo.public.revenue_metrics" },
      },
      obo: {},
    };
    expect(validate(config)).toBe(true);
  });

  test("accepts mixed sp + obo lanes", () => {
    const config = {
      sp: { revenue: { source: "demo.public.revenue" } },
      obo: { customer: { source: "demo.public.customer_metrics" } },
    };
    expect(validate(config)).toBe(true);
  });

  test("accepts an empty configuration", () => {
    expect(validate({})).toBe(true);
    expect(validate({ sp: {}, obo: {} })).toBe(true);
  });

  test("rejects a bare-string entry (must be an object)", () => {
    const config = {
      sp: { revenue: "demo.public.revenue" as any },
    };
    expect(validate(config)).toBe(false);
  });

  test("rejects an entry without source", () => {
    const config = {
      sp: { revenue: {} },
    };
    expect(validate(config)).toBe(false);
  });

  test("rejects unknown fields on entries", () => {
    const config = {
      sp: {
        revenue: {
          source: "demo.public.revenue",
          cacheTtl: 60, // future option, not in v1
        },
      },
    };
    expect(validate(config)).toBe(false);
  });

  test("rejects unknown top-level keys", () => {
    const config = {
      sp: {},
      obo: {},
      unknown: {},
    };
    expect(validate(config)).toBe(false);
  });

  test("rejects a non-three-part FQN", () => {
    const cases = [
      "single",
      "two.parts",
      "four.parts.really.bad",
      ".starts.with.dot",
      "ends.with.dot.",
    ];
    for (const source of cases) {
      const config = { sp: { revenue: { source } as any } };
      expect(validate(config)).toBe(false);
    }
  });

  test("rejects metric keys that start with a digit", () => {
    const config = {
      sp: { "1revenue": { source: "demo.public.revenue" } },
    };
    expect(validate(config)).toBe(false);
  });

  test("accepts metric keys with underscores", () => {
    const config = {
      sp: { customer_metrics: { source: "demo.public.customer_metrics" } },
    };
    expect(validate(config)).toBe(true);
  });
});
