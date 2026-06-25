import fs from "node:fs";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { DatabricksStatementExecutionResponse } from "../types";

const mocks = vi.hoisted(() => ({
  generateQueriesFromDescribe: vi.fn(),
  getWarehouseState: vi.fn(),
  startWarehouse: vi.fn(),
  waitUntilRunning: vi.fn(),
  executeStatement: vi.fn(),
  // In-memory stand-in for the on-disk typegen cache file. `undefined` means
  // "no file yet"; otherwise it holds the serialized JSON exactly as
  // saveCache would have written it, so load/save round-trips behave like
  // the real implementation (string parse, own-property semantics, unknown
  // sibling keys preserved) without touching node_modules/.databricks.
  cacheFile: { contents: undefined as string | undefined },
}));

// Mock only the warehouse-describe step; index.ts owns the throw decision we
// want to exercise (syntax errors fatal, connectivity failures non-fatal).
vi.mock("../query-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../query-registry")>();
  return {
    ...actual,
    generateQueriesFromDescribe: mocks.generateQueriesFromDescribe,
  };
});

// The metric path persists schemas in the shared typegen cache; redirect
// loadCache/saveCache to the in-memory `cacheFile` above so tests control
// cache state per test and nothing leaks to the real cache file (which would
// make DESCRIBE-count assertions order- and rerun-dependent). hashSQL and
// CACHE_VERSION pass through unmocked.
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
          // Corrupted "file": fall through to the fresh-cache default, same
          // as the real loadCache.
        }
      }
      return { version: actual.CACHE_VERSION, queries: {} };
    }),
    saveCache: vi.fn(async (cache: unknown) => {
      mocks.cacheFile.contents = JSON.stringify(cache, null, 2);
    }),
  };
});

// The metric gate's status-only probe and the metric blocking preflight
// resolve through getWarehouseState/startWarehouse/waitUntilRunning; stub all
// three so tests dictate the observed warehouse lifecycle. (query-registry
// also imports these, but its describe step is fully mocked above, so the
// stubs only ever serve the metric path here.)
vi.mock("../warehouse-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../warehouse-status")>();
  return {
    ...actual,
    getWarehouseState: mocks.getWarehouseState,
    startWarehouse: mocks.startWarehouse,
    waitUntilRunning: mocks.waitUntilRunning,
  };
});

// index.ts lazily constructs at most ONE `new WorkspaceClient({})` per pass
// for the whole metric path (status probe + blocking preflight + default
// DESCRIBE fetcher share it). Stub the SDK so no real credentials are needed;
// `executeStatement` doubles as the "was any metric DESCRIBE actually
// issued?" spy and the constructor mock doubles as the client-count spy.
vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn(() => ({
    statementExecution: { executeStatement: mocks.executeStatement },
  })),
}));

const { WorkspaceClient } = await import("@databricks/sdk-experimental");
const { generateFromEntryPoint, TypegenFatalError, TypegenSyntaxError } =
  await import("../index");
// The "../cache" mock spreads the actual module, so this is the real hashSQL —
// used to seed cache entries whose hash genuinely matches the config.
const { hashSQL } = await import("../cache");

const outputDir = path.join(__dirname, "__output__");

describe("generateFromEntryPoint", () => {
  beforeAll(() => {
    // Create output directory once before all tests
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up output directory after all tests complete
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true });
    }
  });

  // Note: Query schema generation now requires Databricks connection
  // This test verifies the basic structure without actual query execution
  test("generates type declarations without query folder", async () => {
    const outFile = path.join(outputDir, "types-with-queries.d.ts");

    await generateFromEntryPoint({
      outFile,
      warehouseId: "test",
    });

    expect(fs.existsSync(outFile)).toBe(true);

    const content = fs.readFileSync(outFile, "utf-8");

    // Check QueryRegistry is included (empty when no queryFolder)
    expect(content).toContain("interface QueryRegistry");
  });

  test("generates empty QueryRegistry when no query folder provided", async () => {
    const outFile = path.join(outputDir, "types-no-queries.d.ts");

    await generateFromEntryPoint({
      outFile,
      warehouseId: "test",
    });

    const content = fs.readFileSync(outFile, "utf-8");

    // QueryRegistry should be empty
    expect(content).toContain("interface QueryRegistry {}");
  });
});

describe("generateFromEntryPoint — query failure handling", () => {
  const failuresDir = path.join(__dirname, "__output_failures__");
  const outFile = path.join(failuresDir, "analytics.d.ts");

  const unknownSchema = (name: string) => ({
    name,
    type: `{ name: "${name}"; parameters: Record<string, never>; result: unknown; }`,
  });

  beforeAll(() => {
    if (!fs.existsSync(failuresDir)) {
      fs.mkdirSync(failuresDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(failuresDir)) {
      fs.rmSync(failuresDir, { recursive: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("throws TypegenSyntaxError when a query has a genuine SQL error", async () => {
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [unknownSchema("bad")],
      syntaxErrors: [{ name: "bad", message: "Table not found: bad" }],
      fatalErrors: [],
    });

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder: "/queries",
        warehouseId: "wh-1",
      }),
    ).rejects.toThrow(TypegenSyntaxError);
  });

  test("TypegenSyntaxError includes fatal queries from a mixed failure", async () => {
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [unknownSchema("bad_sql"), unknownSchema("bad_auth")],
      syntaxErrors: [{ name: "bad_sql", message: "Table not found" }],
      fatalErrors: [{ name: "bad_auth", message: "PERMISSION_DENIED" }],
    });

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder: "/queries",
        warehouseId: "wh-1",
      }),
    ).rejects.toMatchObject({
      name: "TypegenSyntaxError",
      fatalQueries: [{ name: "bad_auth", message: "PERMISSION_DENIED" }],
    });

    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, "utf-8")).toContain("bad_auth");
  });

  test("does not throw when only connectivity failures occurred (warehouse down)", async () => {
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [unknownSchema("a"), unknownSchema("b")],
      syntaxErrors: [],
      fatalErrors: [],
    });

    // The reported bug: a down warehouse must NOT crash type generation.
    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder: "/queries",
        warehouseId: "wh-1",
      }),
    ).resolves.toBeUndefined();
  });

  test("writes the .d.ts before throwing on a syntax error", async () => {
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [unknownSchema("bad")],
      syntaxErrors: [{ name: "bad", message: "Table not found: bad" }],
      fatalErrors: [],
    });

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder: "/queries",
        warehouseId: "wh-1",
      }),
    ).rejects.toThrow(TypegenSyntaxError);

    // Types are emitted even on failure so the build/dev still has a valid file.
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, "utf-8")).toContain(
      "interface QueryRegistry",
    );
  });

  test("throws TypegenFatalError after writing the .d.ts for non-syntax fatal describe errors", async () => {
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [unknownSchema("bad_auth")],
      syntaxErrors: [],
      fatalErrors: [{ name: "bad_auth", message: "PERMISSION_DENIED" }],
    });

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder: "/queries",
        warehouseId: "wh-1",
      }),
    ).rejects.toThrow(TypegenFatalError);

    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, "utf-8")).toContain("bad_auth");
  });
});

describe("generateFromEntryPoint — metric-view emission", () => {
  const metricsDir = path.join(__dirname, "__output_metrics__");
  const queryFolder = path.join(metricsDir, "queries");
  const outFile = path.join(metricsDir, "generated", "analytics.d.ts");
  // Defaults: metric artifacts are siblings of `outFile`.
  const metricFile = path.join(metricsDir, "generated", "metric-views.d.ts");
  const metadataFile = path.join(
    metricsDir,
    "generated",
    "metric-views.metadata.json",
  );

  const describeResponse: DatabricksStatementExecutionResponse = {
    statement_id: "stmt-mock",
    status: { state: "SUCCEEDED" },
    result: {
      data_array: [
        [
          JSON.stringify({
            columns: [
              {
                name: "total_revenue",
                type: "DECIMAL(38,2)",
                is_measure: true,
              },
              { name: "region", type: "STRING", is_measure: false },
            ],
          }),
        ],
      ],
    },
  };

  const writeMetricConfig = () => {
    fs.writeFileSync(
      path.join(queryFolder, "metric-views.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "demo.sales.revenue" } },
      }),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheFile.contents = undefined;
    fs.rmSync(metricsDir, { recursive: true, force: true });
    fs.mkdirSync(queryFolder, { recursive: true });
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [],
      syntaxErrors: [],
      fatalErrors: [],
    });
  });

  afterAll(() => {
    fs.rmSync(metricsDir, { recursive: true, force: true });
  });

  test("writes metric-views.d.ts and metric-views.metadata.json when metric-views.json exists", async () => {
    writeMetricConfig();

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        metricFetcher: async () => describeResponse,
      }),
    ).resolves.toBeUndefined();

    const declarations = fs.readFileSync(metricFile, "utf-8");
    expect(declarations).toContain("interface MetricRegistry");
    expect(declarations).toContain('"revenue"');
    expect(declarations).toContain('"total_revenue": number');
    expect(declarations).toContain('"region": string');

    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue.measures.total_revenue.type).toBe("DECIMAL(38,2)");
    expect(bundle.revenue.dimensions.region.type).toBe("STRING");
  });

  test("emits no metric artifacts and no errors when metric-views.json is absent", async () => {
    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
      }),
    ).resolves.toBeUndefined();

    // Query types are still written; the metric path stays fully dormant.
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.existsSync(metricFile)).toBe(false);
    expect(fs.existsSync(metadataFile)).toBe(false);
  });

  test("a failing metric fetcher warns but query type generation still succeeds", async () => {
    writeMetricConfig();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        generateFromEntryPoint({
          outFile,
          queryFolder,
          warehouseId: "wh-1",
          metricFetcher: async () => {
            throw new Error("DESCRIBE exploded");
          },
        }),
      ).resolves.toBeUndefined();

      // The failure is surfaced per key (key/source/reason) ...
      const warned = warnSpy.mock.calls.flat().map(String).join("\n");
      expect(warned).toContain(
        "metric sync failed for revenue (demo.sales.revenue)",
      );
      expect(warned).toContain("DESCRIBE exploded");
    } finally {
      warnSpy.mockRestore();
    }

    // ... query types are unaffected by the metric failure ...
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, "utf-8")).toContain(
      "interface QueryRegistry",
    );

    // ... and both artifacts still ship, with the failed key carrying a
    // degraded schema (permissive types — its real columns are unknown)
    // rather than poisoning the build.
    const declarations = fs.readFileSync(metricFile, "utf-8");
    expect(declarations).toContain('"revenue"');
    expect(declarations).toContain("measureKeys: string");
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });
  });

  test("a non-terminal DESCRIBE response degrades without failing: no warn, one info line, permissive types", async () => {
    writeMetricConfig();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        generateFromEntryPoint({
          outFile,
          queryFolder,
          warehouseId: "wh-1",
          // Stopped/cold warehouse: the DESCRIBE's wait_timeout elapsed with
          // the statement still PENDING — no rows yet. Previously this fell
          // into the "returned no rows" failure with per-key warns.
          metricFetcher: async () => ({
            statement_id: "stmt-mock",
            status: { state: "PENDING" },
          }),
        }),
      ).resolves.toBeUndefined();

      // Degraded, never an error: no per-key failure warns ...
      const warned = warnSpy.mock.calls.flat().map(String).join("\n");
      expect(warned).not.toContain("metric sync failed");
      // ... exactly one info summary line, naming the degraded key.
      const degradedLines = logSpy.mock.calls
        .map((call) => call.map(String).join(" "))
        .filter((line) => line.includes("degraded metric types"));
      expect(degradedLines).toHaveLength(1);
      expect(degradedLines[0]).toContain("revenue");
      expect(degradedLines[0]).toContain(
        "refresh once the warehouse is available",
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    // Degraded-open rendering: permissive unions for the unknown schema.
    const declarations = fs.readFileSync(metricFile, "utf-8");
    expect(declarations).toContain('"revenue"');
    expect(declarations).toContain("measureKeys: string");
    expect(declarations).toContain("dimensionKeys: string");
    expect(declarations).toContain("timeGrains: string");
    // The metadata bundle keeps its locked frontend-safe shape.
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });
  });

  // ── Non-blocking warehouse gate: metric DESCRIBEs honor the #406 contract ──

  test("non-blocking + warehouse not running: skips all DESCRIBEs but still emits degraded artifacts", async () => {
    fs.writeFileSync(
      path.join(queryFolder, "metric-views.json"),
      JSON.stringify({
        metricViews: {
          revenue: { source: "demo.sales.revenue" },
          churn: { source: "demo.sales.churn", executor: "user" },
        },
      }),
    );
    mocks.getWarehouseState.mockResolvedValue("STOPPED");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        generateFromEntryPoint({
          outFile,
          queryFolder,
          warehouseId: "wh-1",
          mode: "non-blocking",
        }),
      ).resolves.toBeUndefined();

      // One status-only probe, zero DESCRIBE statements against the stopped
      // warehouse (a DESCRIBE would block ~30s per key and auto-start it).
      expect(mocks.getWarehouseState).toHaveBeenCalledTimes(1);
      expect(mocks.executeStatement).not.toHaveBeenCalled();

      // Both artifacts still ship with EVERY configured key present —
      // degraded (permissive types, empty bundle allowlists), key/source/lane
      // intact.
      const declarations = fs.readFileSync(metricFile, "utf-8");
      expect(declarations).toContain('"revenue"');
      expect(declarations).toContain('"churn"');
      expect(declarations).toContain('lane: "obo"');
      expect(declarations).toContain("measureKeys: string");
      expect(declarations).toContain("timeGrains: string");
      const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
      expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });
      expect(bundle.churn).toEqual({ measures: {}, dimensions: {} });

      // Nothing failed (we deliberately didn't probe each key), so no
      // per-key "metric sync failed" warnings — just the single
      // degraded-emit info line. (Unrelated warns, e.g. the migration
      // helper's project-root notice in this temp dir, are not in scope.)
      const warned = warnSpy.mock.calls.flat().map(String).join("\n");
      expect(warned).not.toContain("metric sync failed");
      const logged = logSpy.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("degraded metric types");

      // Query typegen is unaffected.
      expect(fs.existsSync(outFile)).toBe(true);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("non-blocking + RUNNING warehouse: DESCRIBEs run and land full schemas", async () => {
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(describeResponse);

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "non-blocking",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(mocks.executeStatement).toHaveBeenCalledWith(
      expect.objectContaining({
        statement: "DESCRIBE TABLE EXTENDED `demo`.`sales`.`revenue` AS JSON",
        warehouse_id: "wh-1",
      }),
    );
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue.measures.total_revenue.type).toBe("DECIMAL(38,2)");
  });

  // ── Blocking-mode preflight: mirrors the query path's ensure-running flow ──

  test("blocking + RUNNING: one preflight probe, no start/wait, DESCRIBEs run", async () => {
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(describeResponse);

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "blocking",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.getWarehouseState).toHaveBeenCalledTimes(1);
    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).not.toHaveBeenCalled();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );
  });

  test("blocking + STOPPED: preflight starts the warehouse and waits for RUNNING before DESCRIBEs", async () => {
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("STOPPED");
    mocks.startWarehouse.mockResolvedValue(undefined);
    mocks.waitUntilRunning.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(describeResponse);

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "blocking",
      }),
    ).resolves.toBeUndefined();

    // Same flow as the query preflight: probe → start → wait → DESCRIBE,
    // with the start-induced stale STOPPED reading treated as transient.
    expect(mocks.getWarehouseState).toHaveBeenCalledTimes(1);
    expect(mocks.startWarehouse).toHaveBeenCalledWith(
      expect.anything(),
      "wh-1",
    );
    expect(mocks.waitUntilRunning).toHaveBeenCalledWith(
      expect.anything(),
      "wh-1",
      expect.objectContaining({
        maxMs: 300_000,
        treatStoppedAsTransient: true,
      }),
    );
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);

    const order = [
      mocks.getWarehouseState.mock.invocationCallOrder[0],
      mocks.startWarehouse.mock.invocationCallOrder[0],
      mocks.waitUntilRunning.mock.invocationCallOrder[0],
      mocks.executeStatement.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );
  });

  test("blocking + DELETED: fails through the query path's fatal pathway (TypegenFatalError after artifacts are written)", async () => {
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("DELETED");

    const error = await generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-1",
      mode: "blocking",
    }).then(
      () => {
        throw new Error("expected generateFromEntryPoint to reject");
      },
      (err: unknown) => err,
    );

    // Identical surfacing to a query-path fatal preflight: same error class,
    // same per-name fatal entries, same message template.
    expect(error).toBeInstanceOf(TypegenFatalError);
    expect((error as InstanceType<typeof TypegenFatalError>).queries).toEqual([
      { name: "revenue", message: "warehouse wh-1 is DELETED" },
    ]);

    // A deleted warehouse is never started, waited on, or described.
    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).not.toHaveBeenCalled();
    expect(mocks.executeStatement).not.toHaveBeenCalled();

    // Write-first semantics match query fatals: degraded artifacts exist.
    const declarations = fs.readFileSync(metricFile, "utf-8");
    expect(declarations).toContain('"revenue"');
    expect(declarations).toContain("measureKeys: string");
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });

    // D′: the fatal skip is terminal — a deleted warehouse can never serve
    // these keys, so the degraded entries are pinned sticky (retry: false)
    // and later passes surface them via the sticky-hit notice instead of
    // re-describing forever.
    const metrics = JSON.parse(mocks.cacheFile.contents ?? "{}").metrics;
    expect(metrics.revenue.retry).toBe(false);
    expect(metrics.revenue.schema.degraded).toBe(true);
  });

  test("blocking + preflight wait rejects with a timeout: fatal after artifacts (no silent stall)", async () => {
    // A timed-out wait is deterministic, not a connectivity blip: surface it as
    // fatal rather than falling through to DESCRIBE a not-ready warehouse — the
    // ~5-min stall that still "succeeds". (Hybrid: warehouse-level → fatal.)
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("STARTING");
    mocks.waitUntilRunning.mockRejectedValue(
      new Error(
        "Warehouse wh-1 did not reach RUNNING within 300000ms (last state: STARTING)",
      ),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const error = await generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "blocking",
      }).then(
        () => {
          throw new Error("expected generateFromEntryPoint to reject");
        },
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(TypegenFatalError);
      expect((error as InstanceType<typeof TypegenFatalError>).queries).toEqual(
        [expect.objectContaining({ name: "revenue" })],
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    // STARTING → wait-only (no start). We bailed at preflight, so the DESCRIBE
    // batch never ran ...
    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).toHaveBeenCalledWith(
      expect.anything(),
      "wh-1",
      expect.objectContaining({ maxMs: 300_000 }),
    );
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    // ... but degraded artifacts are still written before the throw.
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "measureKeys: string",
    );

    // Terminal skip → sticky, like the decision-time fatal.
    const metrics = JSON.parse(mocks.cacheFile.contents ?? "{}").metrics;
    expect(metrics.revenue.retry).toBe(false);
    expect(metrics.revenue.schema.degraded).toBe(true);
  });

  test("blocking + preflight wait resolves non-RUNNING (STOPPED): degrades, does not throw", async () => {
    // A non-RUNNING *resolve* (not a throw) for a startable state is soft: fall
    // through to DESCRIBE, which degrades on the still-cold warehouse. Only a
    // DELETED/DELETING resolve (or a thrown deterministic error) is fatal.
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("STARTING");
    mocks.waitUntilRunning.mockResolvedValue("STOPPED");
    // The fall-through DESCRIBE hits a still-cold warehouse: non-terminal
    // response, which classifies as degraded (never an error).
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "PENDING" },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        generateFromEntryPoint({
          outFile,
          queryFolder,
          warehouseId: "wh-1",
          mode: "blocking",
        }),
      ).resolves.toBeUndefined();

      // Degraded, not failed: no per-key warns, one info summary line.
      const warned = warnSpy.mock.calls.flat().map(String).join("\n");
      expect(warned).not.toContain("metric sync failed");
      const degradedLines = logSpy.mock.calls
        .map((call) => call.map(String).join(" "))
        .filter((line) => line.includes("degraded metric types"));
      expect(degradedLines).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    // STARTING → wait-only (no start), without treatStoppedAsTransient.
    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(
      mocks.waitUntilRunning.mock.calls[0][2].treatStoppedAsTransient,
    ).toBeUndefined();
    // The DESCRIBE batch still ran (fall-through), and its non-terminal answer
    // degraded the key per Phase 1 semantics.
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "measureKeys: string",
    );

    // D′: a still-startable warehouse is transient degradation — cached with
    // retry: true so the next describe-capable pass converges it.
    const metrics = JSON.parse(mocks.cacheFile.contents ?? "{}").metrics;
    expect(metrics.revenue.retry).toBe(true);
    expect(metrics.revenue.schema.degraded).toBe(true);
  });

  test.each<[string, boolean]>([
    // STOPPED probe → start + wait (treatStoppedAsTransient: a non-RUNNING
    // resolve is necessarily DELETED/DELETING).
    ["STOPPED", true],
    // STARTING probe → wait-only; a DELETED resolve is fatal there too.
    ["STARTING", false],
  ])(
    "blocking + warehouse deleted mid-wait (probe read %s): fatal after artifacts, sticky cache entry",
    async (probedState, startsWarehouse) => {
      writeMetricConfig();
      mocks.getWarehouseState.mockResolvedValue(probedState);
      mocks.startWarehouse.mockResolvedValue(undefined);
      // The warehouse was deleted while the preflight waited: the wait
      // RESOLVES (does not throw) with the terminal state.
      mocks.waitUntilRunning.mockResolvedValue("DELETED");

      const error = await generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "blocking",
      }).then(
        () => {
          throw new Error("expected generateFromEntryPoint to reject");
        },
        (err: unknown) => err,
      );

      // Same fatal pathway as the decision-time DELETED: per-key entries
      // with the query path's message template, thrown after the writes.
      expect(error).toBeInstanceOf(TypegenFatalError);
      expect((error as InstanceType<typeof TypegenFatalError>).queries).toEqual(
        [{ name: "revenue", message: "warehouse wh-1 is DELETED" }],
      );

      expect(mocks.startWarehouse).toHaveBeenCalledTimes(
        startsWarehouse ? 1 : 0,
      );
      // The DESCRIBE batch is skipped — nothing can answer it.
      expect(mocks.executeStatement).not.toHaveBeenCalled();

      // Degraded artifacts are still written before the throw.
      const declarations = fs.readFileSync(metricFile, "utf-8");
      expect(declarations).toContain('"revenue"');
      expect(declarations).toContain("measureKeys: string");
      const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
      expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });

      // D′: terminal skip — sticky, like the decision-time fatal.
      const metrics = JSON.parse(mocks.cacheFile.contents ?? "{}").metrics;
      expect(metrics.revenue.retry).toBe(false);
      expect(metrics.revenue.schema.degraded).toBe(true);
    },
  );

  test("blocking + injected metricFetcher: no preflight calls and no WorkspaceClient construction", async () => {
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("STOPPED");
    const fetcher = vi.fn(async () => describeResponse);

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "blocking",
        metricFetcher: fetcher,
      }),
    ).resolves.toBeUndefined();

    // The injected fetcher needs no warehouse: zero preflight round-trips
    // and zero SDK clients for the whole pass.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.getWarehouseState).not.toHaveBeenCalled();
    expect(mocks.startWarehouse).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).not.toHaveBeenCalled();
    expect(vi.mocked(WorkspaceClient)).not.toHaveBeenCalled();
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );
  });

  // ── One WorkspaceClient per generation pass ──

  test("non-blocking + RUNNING with the default fetcher: probe and DESCRIBEs share exactly one client", async () => {
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(describeResponse);

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "non-blocking",
      }),
    ).resolves.toBeUndefined();

    // The pass both probed AND described — one shared client total.
    expect(mocks.getWarehouseState).toHaveBeenCalledTimes(1);
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(vi.mocked(WorkspaceClient)).toHaveBeenCalledTimes(1);
  });

  test("empty metricViews map: no probe, no preflight, no client — empty artifacts still ship", async () => {
    fs.writeFileSync(
      path.join(queryFolder, "metric-views.json"),
      JSON.stringify({ metricViews: {} }),
    );

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "blocking",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.getWarehouseState).not.toHaveBeenCalled();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    expect(vi.mocked(WorkspaceClient)).not.toHaveBeenCalled();
    expect(fs.existsSync(metricFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(metadataFile, "utf-8"))).toEqual({});
  });

  test("an injected metricFetcher bypasses the gate even when non-blocking + stopped", async () => {
    writeMetricConfig();
    mocks.getWarehouseState.mockResolvedValue("STOPPED");
    const fetcher = vi.fn(async () => describeResponse);

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "non-blocking",
        metricFetcher: fetcher,
      }),
    ).resolves.toBeUndefined();

    // The injected fetcher doesn't hit a warehouse, so it always runs — no
    // probe, no skip. This keeps test/CI injections meaningful.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.getWarehouseState).not.toHaveBeenCalled();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );
  });

  test("non-blocking: a connectivity status-probe failure degrades instead of throwing", async () => {
    writeMetricConfig();
    // A genuine connectivity error (ECONNREFUSED code) reads as transient
    // not-running: the gate degrades and retries next pass, never throwing.
    mocks.getWarehouseState.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    );

    await expect(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-1",
        mode: "non-blocking",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.executeStatement).not.toHaveBeenCalled();
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });
  });

  test("non-blocking: a deterministic status-probe failure (auth) is fatal after artifacts", async () => {
    writeMetricConfig();
    // A 403 carries no connectivity signal: the probe re-throws, the gate pins
    // it fatal (Hybrid: warehouse-level → fatal), and the build fails after the
    // degraded artifacts are written — never silently degrading a misconfig.
    mocks.getWarehouseState.mockRejectedValue(
      Object.assign(
        new Error("PERMISSION_DENIED: cannot read warehouse wh-1"),
        {
          status: 403,
        },
      ),
    );

    const error = await generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-1",
      mode: "non-blocking",
    }).then(
      () => {
        throw new Error("expected generateFromEntryPoint to reject");
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(TypegenFatalError);
    expect((error as InstanceType<typeof TypegenFatalError>).queries).toEqual([
      expect.objectContaining({ name: "revenue" }),
    ]);

    // No DESCRIBE ran; degraded artifacts still written before the throw.
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "measureKeys: string",
    );
  });
});

describe("generateFromEntryPoint — metric cache section", () => {
  const cacheTestDir = path.join(__dirname, "__output_metric_cache__");
  const queryFolder = path.join(cacheTestDir, "queries");
  const outFile = path.join(cacheTestDir, "generated", "analytics.d.ts");
  const metricFile = path.join(cacheTestDir, "generated", "metric-views.d.ts");
  const metadataFile = path.join(
    cacheTestDir,
    "generated",
    "metric-views.metadata.json",
  );

  const describeResponseFor = (
    measure: string,
  ): DatabricksStatementExecutionResponse => ({
    statement_id: "stmt-mock",
    status: { state: "SUCCEEDED" },
    result: {
      data_array: [
        [
          JSON.stringify({
            columns: [
              { name: measure, type: "DECIMAL(38,2)", is_measure: true },
              { name: "region", type: "STRING", is_measure: false },
            ],
          }),
        ],
      ],
    },
  });

  const writeConfig = (
    metricViews: Record<
      string,
      { source: string; executor?: "app_service_principal" | "user" }
    >,
  ) => {
    fs.writeFileSync(
      path.join(queryFolder, "metric-views.json"),
      JSON.stringify({ metricViews }),
    );
  };

  // Parse the in-memory "cache file" the way the next pass's loadCache would.
  const savedCache = () => JSON.parse(mocks.cacheFile.contents ?? "{}");

  const run = (
    overrides: Partial<Parameters<typeof generateFromEntryPoint>[0]> = {},
  ) =>
    generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-1",
      mode: "non-blocking",
      ...overrides,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheFile.contents = undefined;
    fs.rmSync(cacheTestDir, { recursive: true, force: true });
    fs.mkdirSync(queryFolder, { recursive: true });
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [],
      syntaxErrors: [],
      fatalErrors: [],
    });
  });

  afterAll(() => {
    fs.rmSync(cacheTestDir, { recursive: true, force: true });
  });

  test("warm pass: unchanged config makes zero DESCRIBEs, zero probes, zero clients — artifacts rewritten byte-identical from cache", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    const firstDeclarations = fs.readFileSync(metricFile, "utf-8");
    const firstBundle = fs.readFileSync(metadataFile, "utf-8");

    // Wipe the artifacts so pass 2 provably rewrites them from cache alone.
    fs.rmSync(metricFile);
    fs.rmSync(metadataFile);
    vi.clearAllMocks();

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    // All keys were hits, so the gate never even probed the warehouse ...
    expect(mocks.getWarehouseState).not.toHaveBeenCalled();
    // ... and the whole pass constructed zero SDK clients.
    expect(vi.mocked(WorkspaceClient)).not.toHaveBeenCalled();
    expect(fs.readFileSync(metricFile, "utf-8")).toBe(firstDeclarations);
    expect(fs.readFileSync(metadataFile, "utf-8")).toBe(firstBundle);
  });

  test("single-entry edit: only the edited key is re-described", async () => {
    writeConfig({
      churn: { source: "demo.sales.churn" },
      revenue: { source: "demo.sales.revenue" },
    });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    writeConfig({
      churn: { source: "demo.sales.churn" },
      revenue: { source: "demo.sales.revenue_v2" },
    });

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(mocks.executeStatement).toHaveBeenCalledWith(
      expect.objectContaining({
        statement:
          "DESCRIBE TABLE EXTENDED `demo`.`sales`.`revenue_v2` AS JSON",
      }),
    );
    const metrics = savedCache().metrics;
    expect(metrics.churn.retry).toBe(false);
    expect(metrics.revenue.retry).toBe(false);
    expect(metrics.revenue.schema.source).toBe("demo.sales.revenue_v2");
  });

  test("retry convergence: a degraded key is re-described — and only that key — once a blocking pass reaches a RUNNING warehouse", async () => {
    // Pass 0: revenue lands a real schema in the cache.
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );
    await expect(run()).resolves.toBeUndefined();

    // Pass 1: churn added while the warehouse is down. The gate skips its
    // DESCRIBE; churn is cached degraded with retry: true. revenue stays a
    // hit and its good entry is NOT overwritten.
    vi.clearAllMocks();
    mocks.getWarehouseState.mockResolvedValue("STOPPED");
    writeConfig({
      churn: { source: "demo.sales.churn" },
      revenue: { source: "demo.sales.revenue" },
    });
    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    expect(savedCache().metrics.churn.retry).toBe(true);
    expect(savedCache().metrics.churn.schema.degraded).toBe(true);
    expect(savedCache().metrics.revenue.retry).toBe(false);
    // Artifacts mix the cached real schema with the degraded newcomer.
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );

    // Pass 2: blocking with the warehouse RUNNING. Only the retry-flagged
    // key is described; the hit is untouched.
    vi.clearAllMocks();
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("monthly_churn"),
    );
    await expect(run({ mode: "blocking" })).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(mocks.executeStatement).toHaveBeenCalledWith(
      expect.objectContaining({
        statement: "DESCRIBE TABLE EXTENDED `demo`.`sales`.`churn` AS JSON",
      }),
    );
    expect(savedCache().metrics.churn.retry).toBe(false);

    const refreshed = fs.readFileSync(metricFile, "utf-8");
    expect(refreshed).toContain('"monthly_churn": number');
    expect(refreshed).toContain('"total_revenue": number');
    expect(refreshed).not.toContain("measureKeys: string");
  });

  test("last-known-good: warehouse down serves cached real schemas, not degraded ones", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );
    await expect(run()).resolves.toBeUndefined();

    vi.clearAllMocks();
    mocks.getWarehouseState.mockResolvedValue("STOPPED");
    fs.rmSync(metricFile);
    fs.rmSync(metadataFile);

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    expect(mocks.getWarehouseState).not.toHaveBeenCalled();

    // The artifacts carry the cached REAL unions — not degraded-open types.
    const declarations = fs.readFileSync(metricFile, "utf-8");
    expect(declarations).toContain('"total_revenue": number');
    expect(declarations).not.toContain("measureKeys: string");
    const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    expect(bundle.revenue.measures.total_revenue.type).toBe("DECIMAL(38,2)");
    // The good entry survived the warehouse-down pass un-overwritten.
    expect(savedCache().metrics.revenue.retry).toBe(false);
  });

  test("noCache: true re-describes every key despite a warm cache and overwrites the section", async () => {
    writeConfig({
      churn: { source: "demo.sales.churn" },
      legacy: { source: "demo.sales.legacy" },
      revenue: { source: "demo.sales.revenue" },
    });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );
    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(3);

    // Drop `legacy` from the config and rerun with noCache: every remaining
    // key is described again and the section is rebuilt from results only —
    // the stale `legacy` entry does not survive.
    vi.clearAllMocks();
    writeConfig({
      churn: { source: "demo.sales.churn" },
      revenue: { source: "demo.sales.revenue" },
    });

    await expect(run({ noCache: true })).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(2);
    expect(Object.keys(savedCache().metrics).sort()).toEqual([
      "churn",
      "revenue",
    ]);
  });

  test("metric-path save preserves the queries section byte-for-byte, and a metrics-less cache file loads fine", async () => {
    const seededQueries = {
      my_query: {
        hash: "abc123",
        type: '{ name: "my_query"; parameters: Record<string, never>; result: unknown; }',
        retry: false,
      },
    };
    // Pre-metrics cache file: version "3" with no `metrics` section at all.
    mocks.cacheFile.contents = JSON.stringify(
      { version: "3", queries: seededQueries },
      null,
      2,
    );
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);

    const saved = savedCache();
    // Same version (no bump), queries byte-identical, metrics added beside.
    expect(saved.version).toBe("3");
    expect(JSON.stringify(saved.queries)).toBe(JSON.stringify(seededQueries));
    expect(saved.metrics.revenue.retry).toBe(false);
    expect(saved.metrics.revenue.schema.measures[0].name).toBe("total_revenue");
  });

  test("a configured metric key named __proto__ neither pollutes prototypes nor vanishes on save", async () => {
    const protoEntry = {
      hash: "deadbeef",
      schema: {
        key: "__proto__",
        source: "demo.evil.proto",
        lane: "sp",
        measures: [],
        dimensions: [],
        degraded: true,
      },
      retry: true,
    };
    // Computed key keeps "__proto__" an own property of the literal, so the
    // serialized cache file genuinely contains a "__proto__" metrics key.
    mocks.cacheFile.contents = JSON.stringify({
      version: "3",
      queries: {},
      metrics: { ["__proto__"]: protoEntry },
    });
    expect(mocks.cacheFile.contents).toContain('"__proto__"');

    // "__proto__" passes the metric key regex, so a config can genuinely
    // declare it. Keeping it CONFIGURED is what exempts it from pruning —
    // the unconfigured-key case is covered by the prune tests.
    writeConfig({
      ["__proto__"]: { source: "demo.evil.proto" },
      revenue: { source: "demo.sales.revenue" },
    });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );

    await expect(run()).resolves.toBeUndefined();

    // The seeded hash mismatches the configured source, so the key was
    // re-described alongside revenue.
    expect(mocks.executeStatement).toHaveBeenCalledTimes(2);

    // No prototype pollution: the entry's fields never leaked onto plain
    // objects via an Object.prototype mutation — neither on the load copy
    // nor on the describe-result write into the section.
    expect(({} as Record<string, unknown>).hash).toBeUndefined();
    expect(({} as Record<string, unknown>).retry).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("hash");

    // The entry survived load → null-prototype copy → write → save as an
    // OWN key of the section (a plain-object section would have hit the
    // __proto__ setter and silently dropped it from the serialized output).
    expect(mocks.cacheFile.contents).toContain('"__proto__"');
    const metrics = savedCache().metrics;
    expect(Object.hasOwn(metrics, "__proto__")).toBe(true);
    const protoSaved = Object.getOwnPropertyDescriptor(
      metrics,
      "__proto__",
    )?.value;
    expect(protoSaved.retry).toBe(false);
    expect(protoSaved.schema.measures[0].name).toBe("total_revenue");
    expect(metrics.revenue.retry).toBe(false);
  });

  // ── D′ sticky/transient retry semantics ───────────────────────────────

  test("D′ write matrix: transient failures and non-terminal states retry, deterministic failures stick", async () => {
    writeConfig({
      failed_stmt: { source: "demo.sales.failed_stmt" },
      fetch_reject: { source: "demo.sales.fetch_reject" },
      good: { source: "demo.sales.good" },
      no_columns: { source: "demo.sales.no_columns" },
      no_rows: { source: "demo.sales.no_rows" },
      pending: { source: "demo.sales.pending" },
    });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockImplementation(
      async ({ statement }: { statement: string }) => {
        if (statement.includes("fetch_reject")) {
          throw new Error("socket hang up");
        }
        if (statement.includes("failed_stmt")) {
          return {
            statement_id: "stmt-mock",
            status: { state: "FAILED", error: { message: "no such table" } },
          };
        }
        if (statement.includes("no_rows")) {
          return {
            statement_id: "stmt-mock",
            status: { state: "SUCCEEDED" },
            result: { data_array: [] },
          };
        }
        if (statement.includes("no_columns")) {
          return {
            statement_id: "stmt-mock",
            status: { state: "SUCCEEDED" },
            result: { data_array: [[JSON.stringify({ unrelated: true })]] },
          };
        }
        if (statement.includes("pending")) {
          return { statement_id: "stmt-mock", status: { state: "PENDING" } };
        }
        return describeResponseFor("total_revenue");
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(run()).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    const metrics = savedCache().metrics;
    // Transient fetch rejection → re-describe next eligible pass.
    expect(metrics.fetch_reject.retry).toBe(true);
    expect(metrics.fetch_reject.schema.degraded).toBe(true);
    // Non-terminal statement state (not a failure at all) → retry.
    expect(metrics.pending.retry).toBe(true);
    expect(metrics.pending.schema.degraded).toBe(true);
    // Deterministic failures → STICKY: degraded schema cached, no retry.
    for (const key of ["failed_stmt", "no_rows", "no_columns"]) {
      expect(metrics[key].retry).toBe(false);
      expect(metrics[key].schema.degraded).toBe(true);
    }
    // Success → real schema, no retry.
    expect(metrics.good.retry).toBe(false);
    expect(metrics.good.schema.degraded).toBeUndefined();
  });

  test.each<[string, boolean]>([
    // Startable / transient states converge on a later pass → retry.
    ["STOPPED", true],
    ["STARTING", true],
    // A deleted warehouse can never converge → sticky.
    ["DELETED", false],
    ["DELETING", false],
  ])(
    "D′ gate skip: a %s probe caches the skipped keys with retry: %s",
    async (state, retry) => {
      writeConfig({ revenue: { source: "demo.sales.revenue" } });
      mocks.getWarehouseState.mockResolvedValue(state);

      // Non-blocking never throws — even for a deleted warehouse the pass
      // degrades; only the cache disposition differs.
      await expect(run()).resolves.toBeUndefined();
      expect(mocks.executeStatement).not.toHaveBeenCalled();

      const metrics = savedCache().metrics;
      expect(metrics.revenue.retry).toBe(retry);
      expect(metrics.revenue.schema.degraded).toBe(true);
    },
  );

  test("D′ gate skip on DELETED: the sticky entry hits on the next pass and surfaces via the notice", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("DELETED");
    await expect(run()).resolves.toBeUndefined();
    expect(savedCache().metrics.revenue.retry).toBe(false);

    // Warm pass: the sticky entry is a HIT — zero describes, zero probes —
    // and the notice names it.
    vi.clearAllMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(mocks.executeStatement).not.toHaveBeenCalled();
      expect(mocks.getWarehouseState).not.toHaveBeenCalled();
      const stickyLines = warnSpy.mock.calls
        .map((call) => call.map(String).join(" "))
        .filter((line) => line.includes("cached failure"));
      expect(stickyLines).toHaveLength(1);
      expect(stickyLines[0]).toContain("revenue");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("sticky-hit notice: a warm pass over a sticky entry describes nothing and warns once naming the key", async () => {
    // Pass 1: a deterministic DESCRIBE failure pins the key sticky.
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "FAILED", error: { message: "no such table" } },
    });
    const firstWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      // The describing pass reports the failure itself — the cached-failure
      // notice is reserved for passes that merely SERVE the sticky entry.
      const warned = firstWarnSpy.mock.calls.flat().map(String).join("\n");
      expect(warned).toContain("metric sync failed for revenue");
      expect(warned).not.toContain("cached failure");
    } finally {
      firstWarnSpy.mockRestore();
    }
    expect(savedCache().metrics.revenue.retry).toBe(false);

    // Pass 2 (warm): hash match + retry: false ⇒ HIT. No describes, no
    // probes, exactly one warn naming the key and the escape hatches.
    vi.clearAllMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(mocks.executeStatement).not.toHaveBeenCalled();
      expect(mocks.getWarehouseState).not.toHaveBeenCalled();

      const warnedLines = warnSpy.mock.calls.map((call) =>
        call.map(String).join(" "),
      );
      const stickyLines = warnedLines.filter((line) =>
        line.includes("cached failure"),
      );
      expect(stickyLines).toHaveLength(1);
      expect(stickyLines[0]).toContain("revenue");
      expect(stickyLines[0]).toContain("metric-views.json");
      expect(stickyLines[0]).toContain("--no-cache");
      // Nothing was described, so no fresh per-key failure warns.
      expect(warnedLines.join("\n")).not.toContain("metric sync failed");
    } finally {
      warnSpy.mockRestore();
    }

    // The sticky degraded schema still renders permissive artifacts.
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "measureKeys: string",
    );
  });

  test("no sticky-hit notice when the warm pass serves only good entries", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );
    await expect(run()).resolves.toBeUndefined();

    vi.clearAllMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(mocks.executeStatement).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().map(String).join("\n")).not.toContain(
        "cached failure",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("sticky convergence: editing the source (hash change) re-describes a sticky key", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "FAILED", error: { message: "no such table" } },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(savedCache().metrics.revenue.retry).toBe(false);

      // The user fixes the FQN: hash changes, the sticky entry is
      // invalidated, and the key converges to a real schema.
      vi.clearAllMocks();
      mocks.getWarehouseState.mockResolvedValue("RUNNING");
      mocks.executeStatement.mockResolvedValue(
        describeResponseFor("total_revenue"),
      );
      writeConfig({ revenue: { source: "demo.sales.revenue_v2" } });

      await expect(run()).resolves.toBeUndefined();
      expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
      expect(mocks.executeStatement).toHaveBeenCalledWith(
        expect.objectContaining({
          statement:
            "DESCRIBE TABLE EXTENDED `demo`.`sales`.`revenue_v2` AS JSON",
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }

    const metrics = savedCache().metrics;
    expect(metrics.revenue.retry).toBe(false);
    expect(metrics.revenue.schema.degraded).toBeUndefined();
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );
  });

  test("sticky convergence: noCache re-describes a sticky key despite the matching hash", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "FAILED", error: { message: "no such table" } },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(savedCache().metrics.revenue.retry).toBe(false);

      vi.clearAllMocks();
      mocks.getWarehouseState.mockResolvedValue("RUNNING");
      mocks.executeStatement.mockResolvedValue(
        describeResponseFor("total_revenue"),
      );

      await expect(run({ noCache: true })).resolves.toBeUndefined();
      expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }

    const metrics = savedCache().metrics;
    expect(metrics.revenue.retry).toBe(false);
    expect(metrics.revenue.schema.degraded).toBeUndefined();
  });

  // ── Pruning + forced save ──────────────────────────────────────────────

  test("prune: a warm pass over a shrunk config drops the stale key and force-saves", async () => {
    writeConfig({
      churn: { source: "demo.sales.churn" },
      revenue: { source: "demo.sales.revenue" },
    });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );
    await expect(run()).resolves.toBeUndefined();
    expect(Object.keys(savedCache().metrics).sort()).toEqual([
      "churn",
      "revenue",
    ]);

    // Drop churn. revenue is a hit, so nothing is described or probed — but
    // the save must STILL run (forced by the prune) so the file shrinks.
    vi.clearAllMocks();
    writeConfig({ revenue: { source: "demo.sales.revenue" } });

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    expect(mocks.getWarehouseState).not.toHaveBeenCalled();
    expect(Object.keys(savedCache().metrics)).toEqual(["revenue"]);
    expect(savedCache().metrics.revenue.retry).toBe(false);
  });

  test("prune: a describing pass also drops stale keys", async () => {
    writeConfig({
      churn: { source: "demo.sales.churn" },
      revenue: { source: "demo.sales.revenue" },
    });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );
    await expect(run()).resolves.toBeUndefined();

    // Drop churn AND edit revenue: the pass describes revenue (hash change)
    // and prunes churn in the same save.
    vi.clearAllMocks();
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    writeConfig({ revenue: { source: "demo.sales.revenue_v2" } });

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(Object.keys(savedCache().metrics)).toEqual(["revenue"]);
  });

  // ── Revival validation: malformed cache entries are misses, not crashes ──

  const revivableSchema = {
    key: "revenue",
    source: "demo.sales.revenue",
    lane: "sp",
    measures: [{ name: "m", type: "BIGINT", isMeasure: true }],
    dimensions: [{ name: "region", type: "STRING", isMeasure: false }],
  };

  test("revival control: a well-formed seeded entry with a matching hash is served without describing", async () => {
    // Control for the malformed matrix below: same hash/retry mechanics,
    // valid shape ⇒ HIT. Proves the matrix's misses come from validation,
    // not from a hash mismatch.
    mocks.cacheFile.contents = JSON.stringify({
      version: "3",
      queries: {},
      metrics: {
        revenue: {
          hash: hashSQL("demo.sales.revenue|sp"),
          retry: false,
          schema: revivableSchema,
        },
      },
    });
    writeConfig({ revenue: { source: "demo.sales.revenue" } });

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    expect(mocks.getWarehouseState).not.toHaveBeenCalled();
    expect(fs.readFileSync(metricFile, "utf-8")).toContain('"m": number');
  });

  test.each<[string, Record<string, unknown>]>([
    ["schema is null", { schema: null }],
    ["schema is an array", { schema: [] }],
    [
      "schema missing measures",
      { schema: { ...revivableSchema, measures: undefined } },
    ],
    ["invalid lane", { schema: { ...revivableSchema, lane: "x" } }],
    [
      "measures not an array",
      { schema: { ...revivableSchema, measures: "nope" } },
    ],
    [
      "column element missing type",
      { schema: { ...revivableSchema, measures: [{ name: "m" }] } },
    ],
    [
      "non-boolean degraded",
      { schema: { ...revivableSchema, degraded: "yep" } },
    ],
    ["non-string hash", { hash: 42 }],
    ["non-boolean retry", { retry: "yes" }],
  ])(
    "revival validation: %s is a cache miss (re-described), never a crash",
    async (_label, overrides) => {
      mocks.cacheFile.contents = JSON.stringify({
        version: "3",
        queries: {},
        metrics: {
          revenue: {
            hash: hashSQL("demo.sales.revenue|sp"),
            retry: false,
            schema: revivableSchema,
            ...overrides,
          },
        },
      });
      writeConfig({ revenue: { source: "demo.sales.revenue" } });
      mocks.getWarehouseState.mockResolvedValue("RUNNING");
      mocks.executeStatement.mockResolvedValue(
        describeResponseFor("total_revenue"),
      );

      await expect(run()).resolves.toBeUndefined();
      // The malformed entry was not revived: the key was re-described and
      // the cache healed with the fresh result.
      expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
      expect(savedCache().metrics.revenue.retry).toBe(false);
      expect(savedCache().metrics.revenue.schema.measures[0].name).toBe(
        "total_revenue",
      );
      // The artifacts render the fresh schema — never the revived garbage.
      expect(fs.readFileSync(metricFile, "utf-8")).toContain(
        '"total_revenue": number',
      );
    },
  );
});
