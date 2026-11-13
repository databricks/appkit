import fs from "node:fs";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

/**
 * The `--wait` time limit, end to end through the real query and metric-view
 * paths and the real `waitUntilRunning` loop. Only the SDK client is stubbed.
 */

const mocks = vi.hoisted(() => ({
  getWarehouse: vi.fn(),
  startWarehouse: vi.fn(),
  executeStatement: vi.fn(),
}));

vi.mock("../../workspace-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../workspace-client")>();
  return {
    ...actual,
    createWorkspaceClient: () => ({
      statementExecution: { executeStatement: mocks.executeStatement },
      warehouses: {
        getWarehouse: mocks.getWarehouse,
        startWarehouse: mocks.startWarehouse,
      },
    }),
  };
});

// Start every test from an empty typegen cache so each query is described (or
// degraded) rather than served from a previous run.
vi.mock("../cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cache")>();
  return {
    ...actual,
    loadCache: vi.fn(async () => ({
      version: actual.CACHE_VERSION,
      queries: {},
    })),
    saveCache: vi.fn(),
  };
});

const { generateFromEntryPoint, TypegenFatalError } = await import("../index");

const testDir = path.join(__dirname, "__output_wait_limit__");
const queryFolder = path.join(testDir, "queries");
const metricViewsFolder = path.join(testDir, "metric-views");
const outFile = path.join(testDir, "generated", "analytics.d.ts");
const metricFile = path.join(testDir, "generated", "metric-views.d.ts");

const stuck = () => mocks.getWarehouse.mockResolvedValue({ state: "STARTING" });

function describeQueryResult() {
  return {
    statementId: "stmt-1",
    status: { state: "SUCCEEDED" },
    result: { dataArray: [["id", "BIGINT", null]] },
  };
}

function writeCommitted(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf-8");
}

function writeMetricConfig() {
  fs.mkdirSync(metricViewsFolder, { recursive: true });
  fs.writeFileSync(
    path.join(metricViewsFolder, "definitions.json"),
    JSON.stringify({
      metricViews: { revenue: { source: "demo.sales.revenue" } },
    }),
    "utf-8",
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function gateWarnings(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .flat()
    .map(String)
    .filter((line) => line.includes("AppKit typegen"))
    .join("\n");
}

describe("generate-types --wait: warehouse wait limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(queryFolder, { recursive: true });
    fs.writeFileSync(
      path.join(queryFolder, "users.sql"),
      "SELECT id FROM users",
      "utf-8",
    );
    mocks.executeStatement.mockResolvedValue(describeQueryResult());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("running warehouse: describes immediately, no waiting", async () => {
    mocks.getWarehouse.mockResolvedValue({ state: "RUNNING" });

    await generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-1",
      mode: "blocking",
      waitTimeoutMs: 50,
    });

    expect(mocks.getWarehouse).toHaveBeenCalledTimes(1);
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(outFile, "utf-8")).toContain("id: number");
  });

  test("warehouse becomes ready within the limit: waits, then writes real types", async () => {
    mocks.getWarehouse
      .mockResolvedValueOnce({ state: "STARTING" })
      .mockResolvedValue({ state: "RUNNING" });

    await generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-1",
      mode: "blocking",
      waitTimeoutMs: 5_000,
    });

    // Preflight probe (STARTING), then the wait loop's poll that sees RUNNING.
    expect(mocks.getWarehouse).toHaveBeenCalledTimes(2);
    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    const types = fs.readFileSync(outFile, "utf-8");
    expect(types).toContain("id: number");
    expect(types).not.toContain("result: unknown");
  });

  test("limit reached with committed types: keeps them and warns with warehouse, state and limit", async () => {
    stuck();
    const committed = "// committed types\n";
    writeCommitted(outFile, committed);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        generateFromEntryPoint({
          outFile,
          queryFolder,
          warehouseId: "wh-stuck",
          mode: "blocking",
          waitTimeoutMs: 50,
        }),
      ).resolves.toBeUndefined();

      const warnings = gateWarnings(warnSpy);
      expect(warnings).toContain("AppKit typegen: using committed types");
      expect(warnings).toContain(
        "warehouse_unavailable: warehouse wh-stuck is still STARTING after the 50ms wait limit",
      );
      expect(warnings).toContain("kept existing analytics.d.ts");
    } finally {
      warnSpy.mockRestore();
    }

    expect(fs.readFileSync(outFile, "utf-8")).toBe(committed);
    expect(mocks.executeStatement).not.toHaveBeenCalled();
  });

  test("limit reached without committed types: fails with warehouse, state, limit and the knob", async () => {
    stuck();

    const error = await rejection(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-stuck",
        mode: "blocking",
        waitTimeoutMs: 50,
      }),
    );

    expect(error).toBeInstanceOf(TypegenFatalError);
    const message = (error as Error).message;
    expect(message).toContain(
      "warehouse_unavailable: warehouse wh-stuck is still STARTING after the 50ms wait limit",
    );
    expect(message).toContain("no committed types to fall back on");
    expect(message).toContain("No type files were written.");
    expect(message).not.toContain("result: unknown");
    expect((error as { code?: string }).code).toBe("warehouse_unavailable");
    expect(message).toContain("analytics.d.ts");
    expect(message).toContain("--wait-timeout");
    expect(message).toContain("APPKIT_TYPEGEN_WAIT_TIMEOUT");
    expect(fs.existsSync(outFile)).toBe(false);
    expect(mocks.executeStatement).not.toHaveBeenCalled();
  });

  test("a stopped warehouse that never comes up is started, then times out the same way", async () => {
    mocks.getWarehouse
      .mockResolvedValueOnce({ state: "STOPPED" })
      .mockResolvedValue({ state: "STARTING" });

    const error = await rejection(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-cold",
        mode: "blocking",
        waitTimeoutMs: 50,
      }),
    );

    expect(mocks.startWarehouse).toHaveBeenCalledWith(
      { id: "wh-cold" },
      { signal: expect.any(AbortSignal) },
    );
    expect(error).toBeInstanceOf(TypegenFatalError);
    expect((error as Error).message).toContain(
      "warehouse wh-cold is still STARTING after the 50ms wait limit",
    );
  });

  test("a status request that hangs mid-wait still ends at the limit", async () => {
    // Preflight says STARTING, then every warehouses.get hangs.
    mocks.getWarehouse
      .mockResolvedValueOnce({ state: "STARTING" })
      .mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const error = await rejection(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-hung",
        mode: "blocking",
        waitTimeoutMs: 50,
      }),
    );

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(TypegenFatalError);
    expect((error as Error).message).toContain(
      "warehouse_unavailable: warehouse wh-hung is still STARTING after the 50ms wait limit",
    );
  });

  test("APPKIT_TYPEGEN_WAIT_TIMEOUT sets the limit in seconds", async () => {
    stuck();
    vi.stubEnv("APPKIT_TYPEGEN_WAIT_TIMEOUT", "0.05");

    const started = Date.now();
    const error = await rejection(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-stuck",
        mode: "blocking",
      }),
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect((error as Error).message).toContain("after the 50ms wait limit");
  });

  test("queries and metric views share one wait budget", async () => {
    stuck();
    writeMetricConfig();

    const started = Date.now();
    const error = await rejection(
      generateFromEntryPoint({
        outFile,
        queryFolder,
        metricViewsFolder,
        mvOutFile: metricFile,
        warehouseId: "wh-stuck",
        mode: "blocking",
        waitTimeoutMs: 300,
      }),
    );
    const elapsed = Date.now() - started;

    // One 300ms budget for the run, not 300ms per path.
    expect(elapsed).toBeLessThan(550);
    expect(error).toBeInstanceOf(TypegenFatalError);
    const message = (error as Error).message;
    expect(message).toContain(
      "warehouse wh-stuck is still STARTING after the 300ms wait limit",
    );
    expect(message).toContain("analytics.d.ts");
    expect(message).toContain("metric-views.d.ts");
    expect(mocks.executeStatement).not.toHaveBeenCalled();
  });
});
