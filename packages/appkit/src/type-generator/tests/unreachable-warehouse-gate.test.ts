import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * End-to-end coverage for the `--wait` has-types gate when query DESCRIBE
 * cannot produce a schema for environmental reasons.
 *
 * The sibling `index.test.ts` mocks `generateQueriesFromDescribe`, so its gate
 * tests hand the entry point a `hadEnvironmentalFailure: true` they wrote
 * themselves — they would still pass if the query path never set that flag.
 * That is exactly how the original bug survived: the query path reported
 * `false` for a connectivity failure and no test joined the two halves.
 *
 * Here only the client boundary is mocked. The real query path classifies the
 * failure and the real gate decides, so a regression in either half fails a
 * test.
 */

const mocks = vi.hoisted(() => ({
  getWarehouse: vi.fn(),
  executeStatement: vi.fn(),
}));

// Stub the wrapper, not `@databricks/sdk-experimental` underneath it: the
// wrapper re-exports SDK values (`ConfigError`, `Context`, `Time`, `TimeUnits`)
// that a bare SDK factory mock would drop, breaking module init. Spreading
// `importOriginal` keeps those intact while swapping only the factory.
vi.mock("../../workspace-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../workspace-client")>();
  return {
    ...actual,
    createWorkspaceClient: () => ({
      statementExecution: { executeStatement: mocks.executeStatement },
      warehouses: { get: mocks.getWarehouse, start: vi.fn() },
    }),
  };
});

// Keep the on-disk typegen cache out of play: a reused cached type would mask
// the degrade this test depends on.
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

const testDir = path.join(__dirname, "__output_unreachable_gate__");
const queryFolder = path.join(testDir, "queries");
const outFile = path.join(testDir, "generated", "analytics.d.ts");

/** DNS-style transport failure: what a CI runner without warehouse egress sees. */
function unreachableError() {
  return Object.assign(new Error("getaddrinfo ENOTFOUND x.databricks.com"), {
    code: "ENOTFOUND",
  });
}

describe("--wait gate: environmental query failures (real query path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(queryFolder, { recursive: true });
    fs.writeFileSync(
      path.join(queryFolder, "users.sql"),
      "SELECT id FROM users",
      "utf-8",
    );
    mocks.getWarehouse.mockRejectedValue(unreachableError());
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("no committed types → crashes with the run-locally remedy instead of exiting 0", async () => {
    const err = await generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-unreachable",
      mode: "blocking",
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    // The regression this guards: the run used to resolve, write nothing, and
    // exit 0 — leaving the build to fail later with no usable diagnostic.
    expect(err).toBeInstanceOf(TypegenFatalError);
    expect((err as Error).message).toContain("generate-types --wait");
    expect(fs.existsSync(outFile)).toBe(false);
    // Preflight failed, so no DESCRIBE was attempted.
    expect(mocks.executeStatement).not.toHaveBeenCalled();
  });

  test("committed types present → warns 'warehouse unreachable' and keeps them", async () => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const committed = "// committed types\n";
    fs.writeFileSync(outFile, committed, "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-unreachable",
        mode: "blocking",
      });

      const warnings = warnSpy.mock.calls
        .flat()
        .map(String)
        .filter((s) => s.includes("AppKit typegen"))
        .join("\n");

      expect(warnings).toContain("AppKit typegen: using committed types");
      expect(warnings).toContain("wh-unreachable");
      // The label the query path now supplies; it was unreachable in practice
      // while connectivity failures reported no cause at all.
      expect(warnings).toContain("warehouse unreachable");
      // Anti-clobber: the degraded result must not overwrite what was committed.
      expect(fs.readFileSync(outFile, "utf-8")).toBe(committed);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("non-terminal DESCRIBE + no committed types → crashes instead of silently exiting 0", async () => {
    mocks.getWarehouse.mockResolvedValue({ state: "RUNNING" });
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-pending",
      status: { state: "PENDING" },
    });

    const err = await generateFromEntryPoint({
      outFile,
      queryFolder,
      warehouseId: "wh-scaling",
      mode: "blocking",
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TypegenFatalError);
    expect((err as Error).message).toContain("generate-types --wait");
    expect(fs.existsSync(outFile)).toBe(false);
  });

  test("non-terminal DESCRIBE + committed types → warns unavailable and keeps them", async () => {
    mocks.getWarehouse.mockResolvedValue({ state: "RUNNING" });
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-pending",
      status: { state: "RUNNING" },
    });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const committed = "// committed types\n";
    fs.writeFileSync(outFile, committed, "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        generateFromEntryPoint({
          outFile,
          queryFolder,
          warehouseId: "wh-scaling",
          mode: "blocking",
        }),
      ).resolves.toBeUndefined();

      const warnings = warnSpy.mock.calls.flat().map(String).join("\n");
      expect(warnings).toContain("AppKit typegen: using committed types");
      expect(warnings).toContain("warehouse unavailable");
      expect(fs.readFileSync(outFile, "utf-8")).toBe(committed);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("non-blocking mode stays silent and writes degraded types", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Must not throw: the non-blocking default never fails on warehouse state.
      await generateFromEntryPoint({
        outFile,
        queryFolder,
        warehouseId: "wh-unreachable",
        mode: "non-blocking",
      });

      const gateWarnings = warnSpy.mock.calls
        .flat()
        .map(String)
        .filter((s) => s.includes("using committed types"));

      expect(gateWarnings).toEqual([]);
      // Degraded types are written here — the gate is blocking-only.
      expect(fs.existsSync(outFile)).toBe(true);
      expect(fs.readFileSync(outFile, "utf-8")).toContain("result: unknown");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
