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
  queryCacheFileExists: vi.fn(),
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
    queryCacheFileExists: mocks.queryCacheFileExists,
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

  test("bootstrap case: distinguishes missing cache from drift in fatal message", async () => {
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [unknownSchema("query1")],
      syntaxErrors: [],
      fatalErrors: [{ name: "query1", message: "PERMISSION_DENIED" }],
    });
    // Simulate first checkout: no committed cache file yet.
    mocks.queryCacheFileExists.mockResolvedValue(false);

    try {
      await generateFromEntryPoint({
        outFile,
        queryFolder: "/queries",
        warehouseId: "wh-1",
      });
      expect.fail("should have thrown TypegenFatalError");
    } catch (err) {
      expect(err).toBeInstanceOf(TypegenFatalError);
      expect((err as Error).message).toMatch(/No committed type cache found/i);
      expect((err as Error).message).toMatch(/generate-types --wait/i);
      expect((err as Error).message).toMatch(/commit \.appkit\//i);
    }
  });

  test("drift case: cache exists but is stale/missing for failing query", async () => {
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [unknownSchema("query1")],
      syntaxErrors: [],
      fatalErrors: [{ name: "query1", message: "PERMISSION_DENIED" }],
    });
    // Cache file exists but is out of date (the query's key is missing or stale).
    mocks.queryCacheFileExists.mockResolvedValue(true);

    try {
      await generateFromEntryPoint({
        outFile,
        queryFolder: "/queries",
        warehouseId: "wh-1",
      });
      expect.fail("should have thrown TypegenFatalError");
    } catch (err) {
      expect(err).toBeInstanceOf(TypegenFatalError);
      expect((err as Error).message).toMatch(/missing or stale/i);
      expect((err as Error).message).toMatch(/Regenerate with/i);
      expect((err as Error).message).toMatch(/generate-types --wait/i);
      expect((err as Error).message).not.toMatch(
        /No committed type cache found/i,
      );
    }
  });
});

describe("generateFromEntryPoint — metric-view emission", () => {
  const metricsDir = path.join(__dirname, "__output_metrics__");
  const queryFolder = path.join(metricsDir, "queries");
  // The metric config lives in `config/metric-views/` — a sibling of the
  // queries folder. `generateFromEntryPoint` derives it from `queryFolder` when
  // not passed explicitly, so these tests only pass `queryFolder` below.
  const metricViewsFolder = path.join(metricsDir, "metric-views");
  const outFile = path.join(metricsDir, "generated", "analytics.d.ts");
  // Default: the metric .d.ts is a sibling of `outFile`.
  const metricFile = path.join(metricsDir, "generated", "metric-views.d.ts");

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
      path.join(metricViewsFolder, "definitions.json"),
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
    fs.mkdirSync(metricViewsFolder, { recursive: true });
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [],
      syntaxErrors: [],
      fatalErrors: [],
    });
  });

  afterAll(() => {
    fs.rmSync(metricsDir, { recursive: true, force: true });
  });

  test("writes metric-views.d.ts when definitions.json exists", async () => {
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
    // Semantic metadata (SQL type) rides in the .d.ts type-level `metadata`
    // block — the sole carrier now that the JSON bundle is gone.
    expect(declarations).toContain('"DECIMAL(38,2)"');
  });

  test("emits no metric artifacts and no errors when definitions.json is absent", async () => {
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
  });

  // ── Non-blocking warehouse gate: metric DESCRIBEs honor the #406 contract ──

  test("non-blocking + warehouse not running: skips all DESCRIBEs but still emits degraded artifacts", async () => {
    fs.writeFileSync(
      path.join(metricViewsFolder, "definitions.json"),
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
    const declarations = fs.readFileSync(metricFile, "utf-8");
    expect(declarations).toContain('"total_revenue": number');
    // The SQL type rides in the .d.ts type-level `metadata` block.
    expect(declarations).toContain('"DECIMAL(38,2)"');
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

  test("blocking + a per-key DESCRIBE failure: escalates to a build failure (TypegenFatalError)", async () => {
    writeMetricConfig();

    // An injected fetcher always runs and bypasses preflight; throwing makes the
    // key a deterministic DESCRIBE failure. Non-blocking only warns (covered
    // above) — but `--wait` promised correct types, so it must fail the build.
    const error = await generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-1",
      mode: "blocking",
      metricFetcher: async () => {
        throw new Error("DESCRIBE exploded");
      },
    }).then(
      () => {
        throw new Error("expected generateFromEntryPoint to reject");
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(TypegenFatalError);
    expect((error as Error).message).toContain("revenue");
    expect((error as Error).message).toContain("DESCRIBE exploded");

    // Write-first semantics: the degraded artifacts still ship before the throw.
    expect(fs.existsSync(metricFile)).toBe(true);
  });

  test("blocking + a non-terminal DESCRIBE (warehouse not ready): degrades, does NOT escalate", async () => {
    writeMetricConfig();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      // PENDING = the warehouse answered but produced no rows yet → degraded, not
      // a per-key failure. Unlike a bad source (which `--wait` fails), a not-ready
      // warehouse stays a soft degrade even under `--wait`, so infra flakiness
      // can't break the build (mirrors the STOPPED-resolve preflight case).
      await expect(
        generateFromEntryPoint({
          outFile,
          queryFolder,
          warehouseId: "wh-1",
          mode: "blocking",
          metricFetcher: async () => ({
            statement_id: "stmt-mock",
            status: { state: "PENDING" },
          }),
        }),
      ).resolves.toBeUndefined();

      const warned = warnSpy.mock.calls.flat().map(String).join("\n");
      expect(warned).not.toContain("metric sync failed");
      // Permissive artifacts still ship.
      const declarations = fs.readFileSync(metricFile, "utf-8");
      expect(declarations).toContain('"revenue"');
      expect(declarations).toContain("measureKeys: string");
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("malformed definitions.json: a clean TypegenFatalError, not a raw parse error (any mode)", async () => {
    fs.writeFileSync(
      path.join(metricViewsFolder, "definitions.json"),
      "{ not valid",
    );

    // Default (non-blocking) mode: a malformed config is a deterministic
    // developer error and must fail loudly in every mode, surfaced as a
    // message-only TypegenFatalError rather than a bubbled SyntaxError stack.
    const error = await generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-1",
    }).then(
      () => {
        throw new Error("expected generateFromEntryPoint to reject");
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(TypegenFatalError);
    expect((error as Error).message).toContain("definitions.json");
    // Query types were written before the metric config was read.
    expect(fs.existsSync(outFile)).toBe(true);
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

    // The degraded outcome is NEVER cached (mirrors the query path): the key is
    // left uncached so a later pass re-probes, and no stale/sticky entry can be
    // served on a subsequent --wait run.
    const metrics = JSON.parse(mocks.cacheFile.contents ?? "{}").metrics ?? {};
    expect(metrics.revenue).toBeUndefined();
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
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "measureKeys: string",
    );

    // The degraded outcome is not cached — the key stays uncached for the next
    // pass to re-probe.
    const metrics = JSON.parse(mocks.cacheFile.contents ?? "{}").metrics ?? {};
    expect(metrics.revenue).toBeUndefined();
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
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "measureKeys: string",
    );

    // The degraded outcome is not cached; the key stays uncached and the next
    // describe-capable pass re-probes it (convergence via re-describe, not via a
    // cached retry flag).
    const metrics = JSON.parse(mocks.cacheFile.contents ?? "{}").metrics ?? {};
    expect(metrics.revenue).toBeUndefined();
  });

  test.each<[string, boolean]>([
    // STOPPED probe → start + wait (treatStoppedAsTransient: a non-RUNNING
    // resolve is necessarily DELETED/DELETING).
    ["STOPPED", true],
    // STARTING probe → wait-only; a DELETED resolve is fatal there too.
    ["STARTING", false],
  ])(
    "blocking + warehouse deleted mid-wait (probe read %s): fatal after artifacts, degraded outcome not cached",
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

      // The degraded outcome is not cached — no sticky entry to serve later.
      const metrics =
        JSON.parse(mocks.cacheFile.contents ?? "{}").metrics ?? {};
      expect(metrics.revenue).toBeUndefined();
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
      path.join(metricViewsFolder, "definitions.json"),
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
    // An empty metricViews map emits an empty MetricRegistry augmentation.
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "interface MetricRegistry {}",
    );
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
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "measureKeys: string",
    );
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
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      "measureKeys: string",
    );
  });
});

describe("generateFromEntryPoint — metric cache section", () => {
  const cacheTestDir = path.join(__dirname, "__output_metric_cache__");
  const queryFolder = path.join(cacheTestDir, "queries");
  // Metric config lives in the sibling metric-views folder; generateFromEntryPoint
  // derives it from queryFolder when not passed explicitly.
  const metricViewsFolder = path.join(cacheTestDir, "metric-views");
  const outFile = path.join(cacheTestDir, "generated", "analytics.d.ts");
  const metricFile = path.join(cacheTestDir, "generated", "metric-views.d.ts");

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
      path.join(metricViewsFolder, "definitions.json"),
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
    fs.mkdirSync(metricViewsFolder, { recursive: true });
    mocks.generateQueriesFromDescribe.mockResolvedValue({
      schemas: [],
      syntaxErrors: [],
      fatalErrors: [],
    });
  });

  afterAll(() => {
    fs.rmSync(cacheTestDir, { recursive: true, force: true });
  });

  test("warm pass: unchanged config makes zero DESCRIBEs, zero probes, zero clients — the .d.ts is rewritten byte-identical from cache", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    const firstDeclarations = fs.readFileSync(metricFile, "utf-8");

    // Wipe the artifact so pass 2 provably rewrites it from cache alone.
    fs.rmSync(metricFile);
    vi.clearAllMocks();

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    // All keys were hits, so the gate never even probed the warehouse ...
    expect(mocks.getWarehouseState).not.toHaveBeenCalled();
    // ... and the whole pass constructed zero SDK clients.
    expect(vi.mocked(WorkspaceClient)).not.toHaveBeenCalled();
    expect(fs.readFileSync(metricFile, "utf-8")).toBe(firstDeclarations);
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
    // DESCRIBE; churn degrades and is NOT cached (only good describes are). The
    // revenue hit is untouched and keeps its cached good entry.
    vi.clearAllMocks();
    mocks.getWarehouseState.mockResolvedValue("STOPPED");
    writeConfig({
      churn: { source: "demo.sales.churn" },
      revenue: { source: "demo.sales.revenue" },
    });
    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    // churn degraded → left uncached; revenue's good entry survived.
    expect(savedCache().metrics.churn).toBeUndefined();
    expect(savedCache().metrics.revenue.retry).toBe(false);
    expect(savedCache().metrics.revenue.schema.degraded).not.toBe(true);
    // Artifacts mix the cached real schema with the degraded newcomer.
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );

    // Pass 2: blocking with the warehouse RUNNING. churn is uncached, so it is
    // the only key re-described; the revenue hit is untouched.
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
    // churn now has a good cached entry.
    expect(savedCache().metrics.churn.retry).toBe(false);
    expect(savedCache().metrics.churn.schema.degraded).not.toBe(true);

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

    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).not.toHaveBeenCalled();
    expect(mocks.getWarehouseState).not.toHaveBeenCalled();

    // The .d.ts carries the cached REAL unions — not degraded-open types —
    // and its type-level `metadata` block still carries the SQL type.
    const declarations = fs.readFileSync(metricFile, "utf-8");
    expect(declarations).toContain('"total_revenue": number');
    expect(declarations).not.toContain("measureKeys: string");
    expect(declarations).toContain('"DECIMAL(38,2)"');
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

  // ── Degraded outcomes are never cached (mirrors the query path) ────────

  test("write matrix: every degraded outcome is left uncached; only a successful describe is cached", async () => {
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
    // Every degraded outcome — transient (fetch reject, PENDING) OR
    // deterministic (FAILED statement, zero rows, zero columns) — is left
    // uncached, so the next eligible pass simply re-describes it. No sticky
    // entry, no cached degrade to serve.
    for (const key of [
      "fetch_reject",
      "pending",
      "failed_stmt",
      "no_rows",
      "no_columns",
    ]) {
      expect(metrics[key]).toBeUndefined();
    }
    // Only the successful describe is cached — a real schema, retry: false.
    expect(metrics.good.retry).toBe(false);
    expect(metrics.good.schema.degraded).toBeUndefined();
  });

  test.each<string>(["STOPPED", "STARTING", "DELETED", "DELETING"])(
    "gate skip: a %s probe leaves the skipped keys uncached (never sticky)",
    async (state) => {
      writeConfig({ revenue: { source: "demo.sales.revenue" } });
      mocks.getWarehouseState.mockResolvedValue(state);

      // Non-blocking never throws — even for a deleted warehouse the pass
      // degrades. The degraded outcome is not cached regardless of state, so
      // the key is re-probed next pass rather than pinned.
      await expect(run()).resolves.toBeUndefined();
      expect(mocks.executeStatement).not.toHaveBeenCalled();

      expect(savedCache().metrics?.revenue).toBeUndefined();
      // The permissive artifact is still written this pass.
      expect(fs.readFileSync(metricFile, "utf-8")).toContain(
        "measureKeys: string",
      );
    },
  );

  test("a re-run after a degraded pass re-describes the key (no sticky serve)", async () => {
    // Pass 1: a deterministic DESCRIBE failure degrades the key. It is NOT
    // cached, and the describing pass reports the failure itself.
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "FAILED", error: { message: "no such table" } },
    });
    const firstWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      const warned = firstWarnSpy.mock.calls.flat().map(String).join("\n");
      expect(warned).toContain("metric sync failed for revenue");
      // No sticky-cache "cached failure" notice exists anymore.
      expect(warned).not.toContain("cached failure");
    } finally {
      firstWarnSpy.mockRestore();
    }
    expect(savedCache().metrics?.revenue).toBeUndefined();

    // Pass 2: the key is uncached, so it is RE-DESCRIBED (not served from a
    // sticky entry). This time the source resolves — it converges to a real
    // schema with no --no-cache needed.
    vi.clearAllMocks();
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue(
      describeResponseFor("total_revenue"),
    );
    await expect(run()).resolves.toBeUndefined();
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(savedCache().metrics.revenue.retry).toBe(false);
    expect(savedCache().metrics.revenue.schema.degraded).not.toBe(true);
    expect(fs.readFileSync(metricFile, "utf-8")).toContain(
      '"total_revenue": number',
    );
  });

  test("--wait over a still-bad source re-describes and fails the build (never green from a cached degrade)", async () => {
    // Pass 1 (non-blocking): bad source degrades, uncached.
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "FAILED", error: { message: "no such table" } },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
    expect(savedCache().metrics?.revenue).toBeUndefined();

    // Pass 2 (--wait / blocking): the key is uncached, so --wait re-describes
    // it against the still-bad source and escalates to a build failure — it
    // can NOT green-build by serving a cached degrade (the bug this replaces).
    vi.clearAllMocks();
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "FAILED", error: { message: "no such table" } },
    });
    const error = await run({ mode: "blocking" }).then(
      () => {
        throw new Error("expected generateFromEntryPoint to reject");
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(TypegenFatalError);
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
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

  test("convergence: editing the source (hash change) re-describes a previously degraded key", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "FAILED", error: { message: "no such table" } },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      // Degraded → not cached.
      expect(savedCache().metrics?.revenue).toBeUndefined();

      // The user fixes the FQN: the uncached key is re-described (a new hash
      // would force it too) and converges to a real schema.
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

  test("convergence: noCache re-describes a previously degraded key", async () => {
    writeConfig({ revenue: { source: "demo.sales.revenue" } });
    mocks.getWarehouseState.mockResolvedValue("RUNNING");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-mock",
      status: { state: "FAILED", error: { message: "no such table" } },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      // Degraded → not cached.
      expect(savedCache().metrics?.revenue).toBeUndefined();

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
