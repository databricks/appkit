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
  const metricFile = path.join(metricsDir, "generated", "metric.d.ts");
  const metadataFile = path.join(
    metricsDir,
    "generated",
    "metrics.metadata.json",
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

  test("writes metric.d.ts and metrics.metadata.json when metric-views.json exists", async () => {
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
        statement: "DESCRIBE TABLE EXTENDED demo.sales.revenue AS JSON",
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
  });

  test.each([
    [
      "rejects with a timeout",
      () =>
        mocks.waitUntilRunning.mockRejectedValue(
          new Error(
            "Warehouse wh-1 did not reach RUNNING within 300000ms (last state: STARTING)",
          ),
        ),
    ],
    [
      "resolves non-RUNNING",
      () => mocks.waitUntilRunning.mockResolvedValue("STOPPED"),
    ],
  ])(
    "blocking + preflight wait %s: generation does not throw, keys degrade",
    async (_label, armWait) => {
      writeMetricConfig();
      mocks.getWarehouseState.mockResolvedValue("STARTING");
      armWait();
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
      expect(mocks.waitUntilRunning).toHaveBeenCalledWith(
        expect.anything(),
        "wh-1",
        expect.objectContaining({ maxMs: 300_000 }),
      );
      expect(
        mocks.waitUntilRunning.mock.calls[0][2].treatStoppedAsTransient,
      ).toBeUndefined();
      // The DESCRIBE batch still ran (fall-through), and its non-terminal
      // answer degraded the key per Phase 1 semantics.
      expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
      const bundle = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
      expect(bundle.revenue).toEqual({ measures: {}, dimensions: {} });
      expect(fs.readFileSync(metricFile, "utf-8")).toContain(
        "measureKeys: string",
      );
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

  test("non-blocking: a failed status probe degrades instead of throwing", async () => {
    writeMetricConfig();
    mocks.getWarehouseState.mockRejectedValue(
      new Error("connect ECONNREFUSED"),
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
});

describe("generateFromEntryPoint — metric cache section", () => {
  const cacheTestDir = path.join(__dirname, "__output_metric_cache__");
  const queryFolder = path.join(cacheTestDir, "queries");
  const outFile = path.join(cacheTestDir, "generated", "analytics.d.ts");
  const metricFile = path.join(cacheTestDir, "generated", "metric.d.ts");
  const metadataFile = path.join(
    cacheTestDir,
    "generated",
    "metrics.metadata.json",
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
        statement: "DESCRIBE TABLE EXTENDED demo.sales.revenue_v2 AS JSON",
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
        statement: "DESCRIBE TABLE EXTENDED demo.sales.churn AS JSON",
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

  test("a cached metric key named __proto__ neither pollutes prototypes nor vanishes on save", async () => {
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

    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );

    await expect(run()).resolves.toBeUndefined();

    // No prototype pollution: the entry's fields never leaked onto plain
    // objects via an Object.prototype mutation.
    expect(({} as Record<string, unknown>).hash).toBeUndefined();
    expect(({} as Record<string, unknown>).retry).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("hash");

    // The entry survived load → null-prototype copy → save as an OWN key of
    // the section (a plain-object copy would have hit the __proto__ setter
    // and silently dropped it from the serialized output).
    expect(mocks.cacheFile.contents).toContain('"__proto__"');
    const metrics = savedCache().metrics;
    expect(Object.hasOwn(metrics, "__proto__")).toBe(true);
    expect(metrics.revenue.retry).toBe(false);
  });
});
