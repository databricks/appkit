import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  extractMetricColumns,
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
});
