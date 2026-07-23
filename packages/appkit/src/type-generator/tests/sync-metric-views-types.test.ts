import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DescribeFetcher } from "../mv-registry/types";
import type { DatabricksStatementExecutionResponse } from "../types";

/**
 * Unit tests for the metric-only `syncMetricViewsTypes` export — the unified
 * metric pipeline behind `generateFromEntryPoint`'s metric section (and directly
 * callable in its default `describe-now` mode). A mock {@link DescribeFetcher} is
 * injected so the
 * pipeline (read config → resolve → [cache partition] → syncMetrics → write
 * the .d.ts) runs without a warehouse, asserting the MetricRegistry
 * augmentation lands for a mixed fixture (a service-principal metric + an OBO
 * metric; measures + a time-typed dimension + a format spec) and that the
 * shared typegen cache is honored (default) / bypassed (`cache: false`).
 */

// In-memory stand-in for the on-disk typegen cache file so the focused metric
// sync's loadCache/saveCache never touch node_modules/.databricks and each test
// controls cache state. hashSQL / metricCacheHash / isRevivableMetricCacheEntry
// / CACHE_VERSION pass through unmocked (mirrors index.test.ts).
const mocks = vi.hoisted(() => ({
  cacheFile: { contents: undefined as string | undefined },
}));

vi.mock("../cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cache")>();
  return {
    ...actual,
    loadCache: vi.fn(async () => {
      const raw = mocks.cacheFile.contents;
      if (raw !== undefined) {
        try {
          const parsed = JSON.parse(raw) as Awaited<
            ReturnType<typeof actual.loadCache>
          >;
          if (parsed.version === actual.CACHE_VERSION) {
            return parsed;
          }
        } catch {
          // Corrupted "file": fall through to the fresh-cache default.
        }
      }
      return { version: actual.CACHE_VERSION, queries: {} };
    }),
    saveCache: vi.fn(async (cache: unknown) => {
      mocks.cacheFile.contents = JSON.stringify(cache, null, 2);
    }),
  };
});

const { syncMetricViewsTypes } = await import("../index");

/**
 * Build a representative DESCRIBE TABLE EXTENDED ... AS JSON response: one row,
 * one cell, a JSON-string payload (the Statement Execution API shape).
 */
function mockDescribeResponse(
  payload: unknown,
): DatabricksStatementExecutionResponse {
  return {
    statement_id: "stmt-mock",
    status: { state: "SUCCEEDED" },
    result: { data_array: [[JSON.stringify(payload)]] },
  };
}

// Per-FQN DESCRIBE payloads for the mixed fixture. `revenue` (SP lane) exercises
// a currency `format` spec on its measure; `churn` (OBO lane) exercises a
// time-typed dimension (TIMESTAMP → time grains inferred from the SQL type).
const DESCRIBE_BY_FQN: Record<string, unknown> = {
  "demo.sales.revenue": {
    columns: [
      {
        name: "total_revenue",
        type: "DECIMAL(38,2)",
        is_measure: true,
        format: "$#,##0.00",
      },
      { name: "region", type: "STRING", is_measure: false },
    ],
  },
  "demo.sales.churn": {
    columns: [
      { name: "churn_rate", type: "DOUBLE", is_measure: true },
      { name: "event_time", type: "TIMESTAMP", is_measure: false },
    ],
  },
};

describe("syncMetricViewsTypes", () => {
  let tmpRoot: string;
  let metricViewsFolder: string;
  let metricOutFile: string;

  // A spy fetcher so cache tests can assert which FQNs were (re)described.
  const fetcher = vi.fn<DescribeFetcher>(async (fqn) => {
    const payload = DESCRIBE_BY_FQN[fqn];
    if (payload === undefined) {
      throw new Error(`unexpected FQN in test fetcher: ${fqn}`);
    }
    return mockDescribeResponse(payload);
  });

  const writeMixedConfig = () => {
    fs.writeFileSync(
      path.join(metricViewsFolder, "definitions.json"),
      JSON.stringify({
        metricViews: {
          // SP lane (default executor).
          revenue: { source: "demo.sales.revenue" },
          // OBO lane (executor: "user").
          churn: { source: "demo.sales.churn", executor: "user" },
        },
      }),
    );
  };

  beforeEach(() => {
    fetcher.mockClear();
    mocks.cacheFile.contents = undefined;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync-metric-types-"));
    metricViewsFolder = path.join(tmpRoot, "config", "metric-views");
    fs.mkdirSync(metricViewsFolder, { recursive: true });
    metricOutFile = path.join(
      tmpRoot,
      "shared",
      "appkit-types",
      "metric-views.ts",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("writes the MetricRegistry augmentation for a mixed SP + OBO fixture", async () => {
    writeMixedConfig();

    const result = await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });

    // The generated .ts exists on disk.
    expect(fs.existsSync(metricOutFile)).toBe(true);

    // Result reports both keys, no failures, config present.
    expect(result.noConfig).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.schemas.map((s) => s.key).sort()).toEqual([
      "churn",
      "revenue",
    ]);
    expect(result.metricOutFile).toBe(metricOutFile);

    // --- metric-views.ts: MetricRegistry augmentation for both metrics ---
    const declarations = fs.readFileSync(metricOutFile, "utf-8");
    expect(declarations).toContain("interface MetricRegistry");
    expect(declarations).toContain('"revenue"');
    expect(declarations).toContain('"churn"');
    // Measure + dimension column types render as TS primitives.
    expect(declarations).toContain('"total_revenue": number');
    expect(declarations).toContain('"region": string');
    expect(declarations).toContain('"churn_rate": number');
    // The OBO metric's lane is captured in its entry.
    expect(declarations).toContain('lane: "obo"');
    expect(declarations).toContain('lane: "sp"');
    // The TIMESTAMP dimension carries inferred time grains in its @timeGrain tag.
    expect(declarations).toContain("@timeGrain");
    // The semantic metadata (format spec, SQL type) rides in the type-level
    // `metadata` block — the sole carrier now the JSON is gone.
    expect(declarations).toContain('"$#,##0.00"');
    // The file is a real `.ts`: it also carries the runtime `metricViewsMetadata`
    // const, and never a runtime side-effect import (only a type-only one).
    expect(declarations).toContain("export const metricViewsMetadata");
    expect(declarations).toContain("as const");
    expect(declarations).not.toContain('import "@databricks/appkit-ui/react"');
    expect(declarations).toContain(
      'import type {} from "@databricks/appkit-ui/react"',
    );
  });

  test("returns noConfig and writes nothing when definitions.json is absent", async () => {
    const result = await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });

    expect(result.noConfig).toBe(true);
    expect(result.schemas).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(fs.existsSync(metricOutFile)).toBe(false);
  });

  // --- cache behavior (default ON) -------------------------------------------

  test("default (cache on): a warm second run over an unchanged config serves cache hits and describes nothing", async () => {
    writeMixedConfig();

    // First run: both keys are cache misses → both described, results persisted.
    await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    fetcher.mockClear();

    // Second run, same config: both keys hit the cache → zero DESCRIBE calls,
    // and the artifacts are still regenerated from the cached schemas.
    const result = await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    expect(result.schemas.map((s) => s.key).sort()).toEqual([
      "churn",
      "revenue",
    ]);
    // Cached schemas still render the real (non-degraded) types.
    const declarations = fs.readFileSync(metricOutFile, "utf-8");
    expect(declarations).toContain('"total_revenue": number');
    expect(declarations).toContain('"churn_rate": number');
  });

  test("cache: false (--no-cache) re-describes every key even when a warm cache exists", async () => {
    writeMixedConfig();

    // Warm the cache.
    await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    fetcher.mockClear();

    // cache: false ignores the warm section → both keys re-described.
    await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      cache: false,
      metricFetcher: fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("a degraded/failed cached entry is re-described, not served (stricter hit rule)", async () => {
    // Config with one entry whose first DESCRIBE fails (degraded), warming a
    // sticky cache entry; the second run must re-describe it rather than ship
    // the degraded schema.
    fs.writeFileSync(
      path.join(metricViewsFolder, "definitions.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "demo.sales.revenue" } },
      }),
    );

    // First run: fetcher throws → degraded schema + a failure, cached retry:true.
    fetcher.mockRejectedValueOnce(new Error("TABLE_OR_VIEW_NOT_FOUND"));
    const first = await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });
    expect(first.failures).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockClear();

    // Second run, unchanged config, cache ON: the degraded entry is NOT a hit
    // (degraded !== true clause + retry:true) → re-described, now succeeds.
    const second = await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.failures).toEqual([]);
    const declarations = fs.readFileSync(metricOutFile, "utf-8");
    expect(declarations).toContain('"total_revenue": number');
  });

  test("a removed metric key is pruned from the cache section", async () => {
    writeMixedConfig();

    // Warm both keys.
    await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });
    const afterFirst = JSON.parse(mocks.cacheFile.contents ?? "{}");
    expect(Object.keys(afterFirst.metrics).sort()).toEqual([
      "churn",
      "revenue",
    ]);

    // Shrink the config to a single key.
    fs.writeFileSync(
      path.join(metricViewsFolder, "definitions.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "demo.sales.revenue" } },
      }),
    );

    await syncMetricViewsTypes({
      metricViewsFolder,
      warehouseId: "wh-1",
      metricOutFile,
      metricFetcher: fetcher,
    });

    const afterSecond = JSON.parse(mocks.cacheFile.contents ?? "{}");
    expect(Object.keys(afterSecond.metrics)).toEqual(["revenue"]);
  });
});
