import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildMetricsMetadataBundle,
  extractMetricColumns,
  generateMetricsMetadataJson,
  generateMetricTypeDeclarations,
  parseDescribeTableExtendedJson,
  readMetricConfig,
  resolveMetricConfig,
  syncMetrics,
} from "../metric-registry";
import type { DatabricksStatementExecutionResponse } from "../types";

/**
 * Build a representative DESCRIBE TABLE EXTENDED ... AS JSON response.
 *
 * The Statement Execution API returns one row, one cell — a JSON string
 * payload. The shape is broadly:
 *
 * ```json
 * {
 *   "table_name": "...",
 *   "columns": [
 *     { "name": "arr", "type": "DECIMAL(38,2)", "is_measure": true, "comment": "..." },
 *     { "name": "region", "type": "STRING", "is_measure": false }
 *   ]
 * }
 * ```
 *
 * Phase 1 mocks this. Live integration ships in Phase 7.
 */
function mockDescribeResponse(
  payload: unknown,
): DatabricksStatementExecutionResponse {
  return {
    statement_id: "stmt-mock",
    status: { state: "SUCCEEDED" },
    result: {
      data_array: [[JSON.stringify(payload)]],
    },
  };
}

describe("readMetricConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "appkit-metric-typegen-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null when metric.json is absent", async () => {
    expect(await readMetricConfig(tmpDir)).toBeNull();
  });

  test("parses a valid metric.json", async () => {
    await fs.writeFile(
      path.join(tmpDir, "metric.json"),
      JSON.stringify({ sp: { revenue: { source: "demo.public.revenue" } } }),
    );
    const cfg = await readMetricConfig(tmpDir);
    expect(cfg?.sp?.revenue.source).toBe("demo.public.revenue");
  });

  test("throws on malformed JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "metric.json"), "{not json");
    await expect(readMetricConfig(tmpDir)).rejects.toThrowError(
      /parse metric.json/,
    );
  });
});

describe("resolveMetricConfig", () => {
  test("flattens sp + obo lanes into a sorted entries list", () => {
    const cfg = {
      sp: { b_metric: { source: "a.b.c" }, a_metric: { source: "a.b.d" } },
      obo: { c_metric: { source: "a.b.e" } },
    };
    const { entries } = resolveMetricConfig(cfg);
    expect(entries.map((e) => e.key)).toEqual([
      "a_metric",
      "b_metric",
      "c_metric",
    ]);
    expect(entries[0].lane).toBe("sp");
    expect(entries[2].lane).toBe("obo");
  });

  test("rejects duplicate keys across lanes", () => {
    const cfg = {
      sp: { revenue: { source: "a.b.c" } },
      obo: { revenue: { source: "a.b.d" } },
    };
    expect(() => resolveMetricConfig(cfg)).toThrowError(/Duplicate metric/);
  });

  test("rejects unknown entry fields", () => {
    const cfg = {
      sp: { revenue: { source: "a.b.c", cacheTtl: 60 } as any },
    };
    expect(() => resolveMetricConfig(cfg)).toThrowError(/'source' is allowed/);
  });

  test("rejects bad FQN format", () => {
    const cfg = { sp: { revenue: { source: "not.three.part.parts" } } };
    expect(() => resolveMetricConfig(cfg)).toThrowError(/three-part UC FQN/);
  });

  test("rejects a metric key starting with a digit", () => {
    const cfg = { sp: { "1revenue": { source: "a.b.c" } } };
    expect(() => resolveMetricConfig(cfg)).toThrowError(/Invalid metric key/);
  });
});

describe("parseDescribeTableExtendedJson", () => {
  test("parses the JSON payload from the first cell", () => {
    const response = mockDescribeResponse({
      columns: [{ name: "arr", type: "DECIMAL", is_measure: true }],
    });
    const parsed = parseDescribeTableExtendedJson(response);
    expect(parsed).toMatchObject({
      columns: [{ name: "arr", type: "DECIMAL", is_measure: true }],
    });
  });

  test("throws on a FAILED status", () => {
    expect(() =>
      parseDescribeTableExtendedJson({
        statement_id: "x",
        status: { state: "FAILED", error: { message: "no such table" } },
      }),
    ).toThrowError(/no such table/);
  });

  test("throws when the response is empty", () => {
    expect(() =>
      parseDescribeTableExtendedJson({
        statement_id: "x",
        status: { state: "SUCCEEDED" },
        result: { data_array: [] },
      }),
    ).toThrowError(/no rows/);
  });

  test("throws when the cell is not a JSON string", () => {
    expect(() =>
      parseDescribeTableExtendedJson({
        statement_id: "x",
        status: { state: "SUCCEEDED" },
        result: { data_array: [[null]] },
      }),
    ).toThrowError(/JSON string/);
  });
});

describe("extractMetricColumns", () => {
  test("extracts measures and dimensions from the standard shape", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL(38,2)",
          is_measure: true,
          comment: "Annual recurring revenue",
        },
        { name: "region", type: "STRING", is_measure: false },
      ],
    });
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({
      name: "arr",
      type: "DECIMAL(38,2)",
      isMeasure: true,
      description: "Annual recurring revenue",
    });
    expect(cols[1]).toMatchObject({
      name: "region",
      type: "STRING",
      isMeasure: false,
    });
  });

  test("falls back to schema.fields shape", () => {
    const cols = extractMetricColumns({
      schema: {
        fields: [
          {
            name: "mrr",
            type: { name: "DOUBLE" },
            metadata: { is_measure: true },
          },
        ],
      },
    });
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({
      name: "mrr",
      type: "DOUBLE",
      isMeasure: true,
    });
  });

  test("returns empty array on unrecognized shape", () => {
    expect(extractMetricColumns({ unrelated: true })).toEqual([]);
  });

  // ── Phase 2: time-typed dimensions ────────────────────────────────────
  test("captures time_grain attribute on a time-typed dimension", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "created_at",
          type: "DATE",
          is_measure: false,
          time_grain: ["day", "week", "month"],
        },
        { name: "region", type: "STRING", is_measure: false },
      ],
    });
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({
      name: "created_at",
      type: "DATE",
      isMeasure: false,
      timeGrains: ["day", "month", "week"], // sorted, deduped
    });
    // Non-time dim has no timeGrains key.
    expect(cols[1].timeGrains).toBeUndefined();
  });

  test("normalizes time_grain values to lowercase + sorted + deduped", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "ts",
          type: "TIMESTAMP",
          is_measure: false,
          time_grain: ["MONTH", "day", "Day", "week"],
        },
      ],
    });
    expect(cols[0].timeGrains).toEqual(["day", "month", "week"]);
  });

  test("falls back to metadata.time_grain (DESCRIBE wraps it under metadata)", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "ts",
          type: "TIMESTAMP",
          metadata: { is_measure: false, time_grain: ["day"] },
        },
      ],
    });
    expect(cols[0].timeGrains).toEqual(["day"]);
  });

  test("treats empty time_grain attribute as not time-typed", () => {
    const cols = extractMetricColumns({
      columns: [
        { name: "ts", type: "TIMESTAMP", is_measure: false, time_grain: [] },
      ],
    });
    expect(cols[0].timeGrains).toBeUndefined();
  });

  test("ignores non-string time_grain entries", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "ts",
          type: "TIMESTAMP",
          is_measure: false,
          time_grain: ["day", null, 42, "week"],
        },
      ],
    });
    expect(cols[0].timeGrains).toEqual(["day", "week"]);
  });
});

describe("syncMetrics", () => {
  test("returns one schema per resolved entry, columns split by measure flag", async () => {
    const resolution = resolveMetricConfig({
      sp: { revenue: { source: "demo.public.revenue" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          { name: "arr", type: "DECIMAL(38,2)", is_measure: true },
          { name: "mrr", type: "DECIMAL(38,2)", is_measure: true },
          { name: "region", type: "STRING", is_measure: false },
        ],
      });

    const schemas = await syncMetrics(resolution, fetcher);
    expect(schemas).toHaveLength(1);
    const [schema] = schemas;
    expect(schema.key).toBe("revenue");
    expect(schema.measures.map((m) => m.name)).toEqual(["arr", "mrr"]);
    expect(schema.dimensions.map((d) => d.name)).toEqual(["region"]);
  });

  test("falls back to empty columns when DESCRIBE throws (does not crash typegen)", async () => {
    const resolution = resolveMetricConfig({
      sp: { revenue: { source: "demo.public.revenue" } },
    });

    const fetcher = async () => {
      throw new Error("warehouse unreachable");
    };

    const schemas = await syncMetrics(resolution, fetcher);
    expect(schemas[0].measures).toEqual([]);
    expect(schemas[0].dimensions).toEqual([]);
  });
});

describe("generateMetricTypeDeclarations — snapshot", () => {
  test("emits a stable MetricRegistry augmentation for a representative input", async () => {
    const resolution = resolveMetricConfig({
      sp: { revenue: { source: "appkit_demo.public.revenue_metrics" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          {
            name: "arr",
            type: "DECIMAL(38,2)",
            is_measure: true,
            comment: "Annual recurring revenue",
          },
          {
            name: "mrr",
            type: "DECIMAL(38,2)",
            is_measure: true,
            comment: "Monthly recurring revenue",
          },
          { name: "region", type: "STRING", is_measure: false },
          { name: "segment", type: "STRING", is_measure: false },
        ],
      });

    const schemas = await syncMetrics(resolution, fetcher);
    const output = generateMetricTypeDeclarations(schemas);
    expect(output).toMatchSnapshot();
  });

  test("emits an empty MetricRegistry interface when no metrics are registered", () => {
    const output = generateMetricTypeDeclarations([]);
    expect(output).toMatchSnapshot();
  });

  // ── Phase 2: time-typed dim + multiple non-time dims fixture ─────────
  test("emits TimeGrain<K> union for a metric view with time-typed + regular dimensions", async () => {
    const resolution = resolveMetricConfig({
      sp: {
        revenue: { source: "appkit_demo.public.revenue_metrics_v2" },
      },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          {
            name: "arr",
            type: "DECIMAL(38,2)",
            is_measure: true,
            comment: "Annual recurring revenue",
          },
          {
            name: "created_at",
            type: "TIMESTAMP",
            is_measure: false,
            time_grain: ["day", "week", "month"],
          },
          { name: "region", type: "STRING", is_measure: false },
          { name: "segment", type: "STRING", is_measure: false },
        ],
      });

    const schemas = await syncMetrics(resolution, fetcher);
    const output = generateMetricTypeDeclarations(schemas);
    expect(output).toMatchSnapshot();

    // Sanity assertions in addition to the snapshot, so future drift surfaces
    // even when snapshots are blindly updated.
    expect(output).toContain('timeGrains: "day" | "month" | "week"');
    expect(output).toContain("@timeGrain day|month|week");
    expect(output).toContain('"created_at": string');
    expect(output).toContain('"region": string');
  });
});

// ── Phase 5: semantic-metadata extraction (display_name + format) ─────────
describe("extractMetricColumns — Phase 5 semantic metadata", () => {
  test("captures display_name from a measure column", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL(38,2)",
          is_measure: true,
          display_name: "Annual Recurring Revenue",
          comment: "ARR for the period",
        },
      ],
    });
    expect(cols[0]).toMatchObject({
      name: "arr",
      type: "DECIMAL(38,2)",
      isMeasure: true,
      displayName: "Annual Recurring Revenue",
      description: "ARR for the period",
    });
  });

  test("captures format spec from a measure column", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL(38,2)",
          is_measure: true,
          format: "$#,##0.00",
        },
      ],
    });
    expect(cols[0].format).toBe("$#,##0.00");
  });

  test("captures display_name + format on a dimension column", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "region",
          type: "STRING",
          is_measure: false,
          display_name: "Region",
          format: undefined,
        },
      ],
    });
    expect(cols[0]).toMatchObject({
      name: "region",
      isMeasure: false,
      displayName: "Region",
    });
    expect(cols[0].format).toBeUndefined();
  });

  test("falls back to displayName camelCase variant", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "mrr",
          type: "DECIMAL",
          is_measure: true,
          displayName: "Monthly Recurring Revenue",
        },
      ],
    });
    expect(cols[0].displayName).toBe("Monthly Recurring Revenue");
  });

  test("reads display_name + format from metadata.<name> (DESCRIBE wrap)", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL(38,2)",
          metadata: {
            is_measure: true,
            display_name: "ARR",
            format: "$#,##0.00",
          },
        },
      ],
    });
    expect(cols[0]).toMatchObject({
      isMeasure: true,
      displayName: "ARR",
      format: "$#,##0.00",
    });
  });

  test("treats empty / whitespace display_name as absent", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL",
          is_measure: true,
          display_name: "   ",
          format: "",
        },
      ],
    });
    expect(cols[0].displayName).toBeUndefined();
    expect(cols[0].format).toBeUndefined();
  });

  test("captures format from format_spec alias", () => {
    const cols = extractMetricColumns({
      columns: [
        {
          name: "arr",
          type: "DECIMAL",
          is_measure: true,
          format_spec: "$#,##0.00",
        },
      ],
    });
    expect(cols[0].format).toBe("$#,##0.00");
  });
});

// ── Phase 5: metadata bundle generation ───────────────────────────────────
describe("buildMetricsMetadataBundle", () => {
  test("emits per-metric measures + dimensions records keyed by name", async () => {
    const resolution = resolveMetricConfig({
      sp: { revenue: { source: "appkit_demo.public.revenue_metrics" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          {
            name: "arr",
            type: "DECIMAL(38,2)",
            is_measure: true,
            display_name: "Annual Recurring Revenue",
            format: "$#,##0.00",
            comment: "ARR for the period",
          },
          { name: "region", type: "STRING", is_measure: false },
          {
            name: "created_at",
            type: "TIMESTAMP",
            is_measure: false,
            time_grain: ["day", "month"],
          },
        ],
      });

    const schemas = await syncMetrics(resolution, fetcher);
    const bundle = buildMetricsMetadataBundle(schemas);

    expect(bundle.revenue).toMatchObject({
      source: "appkit_demo.public.revenue_metrics",
      lane: "sp",
      measures: {
        arr: {
          type: "DECIMAL(38,2)",
          display_name: "Annual Recurring Revenue",
          format: "$#,##0.00",
          description: "ARR for the period",
        },
      },
      dimensions: {
        region: {
          type: "STRING",
        },
        created_at: {
          type: "TIMESTAMP",
          time_grain: ["day", "month"],
        },
      },
    });
  });

  test("preserves stable alphabetical key order across metrics", async () => {
    const resolution = resolveMetricConfig({
      sp: {
        z_metric: { source: "demo.public.z_metric" },
        a_metric: { source: "demo.public.a_metric" },
      },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [{ name: "v", type: "DECIMAL", is_measure: true }],
      });

    const schemas = await syncMetrics(resolution, fetcher);
    const bundle = buildMetricsMetadataBundle(schemas);
    expect(Object.keys(bundle)).toEqual(["a_metric", "z_metric"]);
  });

  test("omits absent fields rather than emitting null/empty placeholders", async () => {
    const resolution = resolveMetricConfig({
      sp: { revenue: { source: "demo.public.revenue" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [{ name: "arr", type: "DECIMAL", is_measure: true }],
      });

    const schemas = await syncMetrics(resolution, fetcher);
    const bundle = buildMetricsMetadataBundle(schemas);
    const arr = bundle.revenue.measures.arr;
    expect(arr.type).toBe("DECIMAL");
    expect(arr.display_name).toBeUndefined();
    expect(arr.format).toBeUndefined();
    expect(arr.description).toBeUndefined();
    expect(arr.time_grain).toBeUndefined();
  });

  test("only emits time_grain on time-typed dimensions, never on measures", async () => {
    const resolution = resolveMetricConfig({
      sp: { revenue: { source: "demo.public.revenue" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          // Time-grain on a measure should not be picked up — measures never
          // carry time_grain in the YAML 1.1 spec; defending here is belt-
          // and-suspenders, in case DESCRIBE leaks a stray attribute.
          {
            name: "arr",
            type: "DECIMAL",
            is_measure: true,
            time_grain: ["day"],
          },
          {
            name: "ts",
            type: "TIMESTAMP",
            is_measure: false,
            time_grain: ["day", "month"],
          },
        ],
      });

    const schemas = await syncMetrics(resolution, fetcher);
    const bundle = buildMetricsMetadataBundle(schemas);
    expect(bundle.revenue.measures.arr.time_grain).toBeUndefined();
    expect(bundle.revenue.dimensions.ts.time_grain).toEqual(["day", "month"]);
  });
});

// ── Phase 5: metadata JSON serialization ──────────────────────────────────
describe("generateMetricsMetadataJson — snapshot", () => {
  test("serializes a representative metric view with display_name + format + time_grain", async () => {
    const resolution = resolveMetricConfig({
      sp: {
        revenue: { source: "appkit_demo.public.revenue_metrics" },
      },
      obo: {
        customer_metrics: {
          source: "appkit_demo.public.customer_metrics",
        },
      },
    });

    const fetcher = async (fqn: string) =>
      fqn.endsWith("revenue_metrics")
        ? mockDescribeResponse({
            columns: [
              {
                name: "arr",
                type: "DECIMAL(38,2)",
                is_measure: true,
                display_name: "Annual Recurring Revenue",
                format: "$#,##0.00",
                comment: "ARR per quarter",
              },
              {
                name: "growth_rate",
                type: "DOUBLE",
                is_measure: true,
                display_name: "Growth Rate",
                format: "0.0%",
              },
              {
                name: "region",
                type: "STRING",
                is_measure: false,
                display_name: "Region",
              },
              {
                name: "created_at",
                type: "TIMESTAMP",
                is_measure: false,
                display_name: "Period",
                time_grain: ["day", "week", "month", "quarter"],
              },
            ],
          })
        : mockDescribeResponse({
            columns: [
              {
                name: "churn_rate",
                type: "DOUBLE",
                is_measure: true,
                display_name: "Churn Rate",
                format: "0.0%",
              },
              {
                name: "csm_email",
                type: "STRING",
                is_measure: false,
                display_name: "CSM Email",
              },
            ],
          });

    const schemas = await syncMetrics(resolution, fetcher);
    const json = generateMetricsMetadataJson(schemas);
    expect(json).toMatchSnapshot();

    // Guard against snapshot blind-update: structural assertions on the parsed JSON.
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual(["customer_metrics", "revenue"]);
    expect(parsed.revenue.measures.arr.format).toBe("$#,##0.00");
    expect(parsed.revenue.measures.arr.display_name).toBe(
      "Annual Recurring Revenue",
    );
    // Time grains are sorted lexicographically by extractMetricColumns (Phase 2).
    expect(parsed.revenue.dimensions.created_at.time_grain).toEqual([
      "day",
      "month",
      "quarter",
      "week",
    ]);
    expect(parsed.customer_metrics.lane).toBe("obo");
  });

  test("emits `{}` when no metrics are registered", () => {
    expect(generateMetricsMetadataJson([])).toBe("{}\n");
  });
});

// ── Phase 2: syncMetrics propagates timeGrains end-to-end ────────────────
describe("syncMetrics — time-typed dimension propagation", () => {
  test("propagates the time_grain attribute onto the resulting MetricSchema", async () => {
    const resolution = resolveMetricConfig({
      sp: { revenue: { source: "demo.public.revenue" } },
    });

    const fetcher = async () =>
      mockDescribeResponse({
        columns: [
          { name: "arr", type: "DECIMAL", is_measure: true },
          {
            name: "ts",
            type: "TIMESTAMP",
            is_measure: false,
            time_grain: ["day", "month"],
          },
          { name: "region", type: "STRING", is_measure: false },
        ],
      });

    const schemas = await syncMetrics(resolution, fetcher);
    expect(schemas[0].dimensions).toHaveLength(2);
    const tsDim = schemas[0].dimensions.find((d) => d.name === "ts");
    expect(tsDim?.timeGrains).toEqual(["day", "month"]);
    const regionDim = schemas[0].dimensions.find((d) => d.name === "region");
    expect(regionDim?.timeGrains).toBeUndefined();
  });
});
