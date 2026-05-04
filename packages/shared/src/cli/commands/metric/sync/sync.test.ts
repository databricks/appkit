import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFetchError,
  exitCodeFor,
  type MetricSyncDependencies,
  MetricSyncError,
  runMetricSync,
} from "./sync";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Build a fully-mocked {@link MetricSyncDependencies} that records what was
 * called. Tests override individual fields (e.g. swap in a throwing fetcher
 * factory to simulate auth-failed) without re-stating the rest.
 */
function makeDeps(
  overrides: Partial<MetricSyncDependencies> = {},
): MetricSyncDependencies {
  return {
    syncMetrics: vi.fn(async (resolution, fetcher) => {
      // Default: call the fetcher once per entry and emit a stub schema.
      const schemas: Array<{
        key: string;
        source: string;
        lane: "sp" | "obo";
        measures: never[];
        dimensions: never[];
      }> = [];
      for (const entry of resolution.entries) {
        try {
          await fetcher(entry.source);
        } catch {
          // mirror the real syncMetrics behavior — it tolerates per-entry
          // failures and emits empty schemas. The CLI's wrapped fetcher
          // captures the first failure and re-throws after this returns.
        }
        schemas.push({
          key: entry.key,
          source: entry.source,
          lane: entry.lane,
          measures: [],
          dimensions: [],
        });
      }
      // The mock returns no failures by default — tests that need to
      // exercise the failures-surfacing path override this seam.
      return { schemas, failures: [] };
    }),
    resolveMetricConfig: vi.fn((config) => {
      const cfg = config as {
        sp?: Record<string, { source: string }>;
        obo?: Record<string, { source: string }>;
      };
      // Mirror the real `resolveMetricConfig`: sp first, then obo, each
      // alphabetically sorted by key. This is the contract callers (and
      // syncMetrics) rely on for deterministic ordering.
      const entries: Array<{
        key: string;
        source: string;
        lane: "sp" | "obo";
      }> = [];
      for (const lane of ["sp", "obo"] as const) {
        const laneMap = cfg[lane] ?? {};
        for (const key of Object.keys(laneMap).sort()) {
          entries.push({ key, source: laneMap[key].source, lane });
        }
      }
      return { entries };
    }),
    createWorkspaceDescribeFetcher: vi.fn(() => async (_fqn: string) => ({
      ok: true,
    })),
    generateMetricTypeDeclarations: vi.fn(() => "// generated metric.d.ts\n"),
    generateMetricsMetadataJson: vi.fn(() => "{}\n"),
    metricTypesFile: "metric.d.ts",
    metricMetadataFile: "metrics.metadata.json",
    ...overrides,
  };
}

/**
 * Capture console writes through the IO seam so snapshots are deterministic.
 */
function captureIO() {
  const log: string[] = [];
  const error: string[] = [];
  return {
    log: (msg: string) => log.push(msg),
    error: (msg: string) => error.push(msg),
    output: () => log.join("\n"),
    errors: () => error.join("\n"),
  };
}

const VALID_METRIC_JSON = {
  $schema:
    "https://databricks.github.io/appkit/schemas/metric-source.schema.json",
  sp: {
    revenue: { source: "demo.public.revenue" },
  },
  obo: {
    customer_metrics: { source: "demo.public.customer_metrics" },
  },
};

// ── classifyFetchError ─────────────────────────────────────────────────────

describe("classifyFetchError", () => {
  it("classifies 401 unauthorized as auth-failed", () => {
    const err = new Error("Request failed: 401 Unauthorized");
    const classified = classifyFetchError(err, "demo.public.x");
    expect(classified.code).toBe("auth-failed");
    expect(classified.message).toMatch(/Authentication failed/);
  });

  it("classifies 403 forbidden as auth-failed", () => {
    const err = new Error("HTTP 403 forbidden");
    expect(classifyFetchError(err, "x.y.z").code).toBe("auth-failed");
  });

  it("classifies token-expired as auth-failed", () => {
    const err = new Error("OAuth token expired; please refresh");
    expect(classifyFetchError(err, "x.y.z").code).toBe("auth-failed");
  });

  it("classifies 'not found' as missing-fqn", () => {
    const err = new Error("TABLE_OR_VIEW_NOT_FOUND: relation x.y.z not found");
    const classified = classifyFetchError(err, "x.y.z");
    expect(classified.code).toBe("missing-fqn");
    expect(classified.message).toContain("'x.y.z'");
  });

  it("classifies 'does not exist' as missing-fqn", () => {
    const err = new Error("Table x.y.z does not exist");
    expect(classifyFetchError(err, "x.y.z").code).toBe("missing-fqn");
  });

  it("classifies ECONNREFUSED as warehouse-unreach", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    expect(classifyFetchError(err, "x.y.z").code).toBe("warehouse-unreach");
  });

  it("classifies ETIMEDOUT as warehouse-unreach", () => {
    const err = new Error("Request ETIMEDOUT after 30s");
    expect(classifyFetchError(err, "x.y.z").code).toBe("warehouse-unreach");
  });

  it("classifies unknown errors as unknown", () => {
    const err = new Error("Unexpected internal error");
    expect(classifyFetchError(err, "x.y.z").code).toBe("unknown");
  });
});

// ── exitCodeFor ────────────────────────────────────────────────────────────

describe("exitCodeFor", () => {
  it("maps each MetricSyncErrorCode to its canonical exit code", () => {
    expect(exitCodeFor("missing-fqn")).toBe(1);
    expect(exitCodeFor("warehouse-unreach")).toBe(2);
    expect(exitCodeFor("malformed-config")).toBe(3);
    expect(exitCodeFor("auth-failed")).toBe(4);
    expect(exitCodeFor("unknown")).toBe(5);
  });
});

// ── runMetricSync — happy paths ────────────────────────────────────────────

describe("runMetricSync — success", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("metric-sync-success");
    fs.mkdirSync(path.join(tmp, "config", "queries"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "config", "queries", "metric.json"),
      JSON.stringify(VALID_METRIC_JSON, null, 2),
    );
  });

  afterEach(() => cleanDir(tmp));

  it("emits metric.d.ts and metrics.metadata.json on success", async () => {
    const io = captureIO();
    const deps = makeDeps();
    const ctx = await runMetricSync(
      {
        warehouseId: "stub-warehouse",
        rootDir: tmp,
        silent: true,
      },
      { ...io, deps, interactive: false },
    );

    expect(ctx.warehouseId).toBe("stub-warehouse");
    expect(fs.existsSync(ctx.metricTypesPath)).toBe(true);
    expect(fs.existsSync(ctx.metricMetadataPath)).toBe(true);
    expect(deps.syncMetrics).toHaveBeenCalledTimes(1);
  });

  it("produces a stable success-stdout snapshot", async () => {
    const io = captureIO();
    const deps = makeDeps();
    await runMetricSync(
      {
        warehouseId: "stub-warehouse",
        rootDir: tmp,
      },
      { ...io, deps, interactive: false },
    );

    // Normalize the warehouse-relative path component for portability.
    const snapshot = io
      .output()
      .replace(/Syncing \d+ metric\(s\) from /g, "Syncing N metric(s) from ");
    expect(snapshot).toMatchSnapshot();
  });

  it("treats an empty metric.json as a no-op (no fetch call)", async () => {
    fs.writeFileSync(
      path.join(tmp, "config", "queries", "metric.json"),
      JSON.stringify({ sp: {}, obo: {} }, null, 2),
    );

    const io = captureIO();
    const deps = makeDeps();
    await runMetricSync(
      {
        warehouseId: "stub-warehouse",
        rootDir: tmp,
      },
      { ...io, deps, interactive: false },
    );

    expect(deps.syncMetrics).not.toHaveBeenCalled();
    expect(io.output()).toMatchSnapshot();
  });

  it("respects --metric-json-path and --output-dir overrides", async () => {
    const altDir = path.join(tmp, "alt-config");
    fs.mkdirSync(altDir, { recursive: true });
    const altPath = path.join(altDir, "metrics.json");
    fs.writeFileSync(altPath, JSON.stringify(VALID_METRIC_JSON, null, 2));

    const altOut = path.join(tmp, "build-out");

    const io = captureIO();
    const deps = makeDeps();
    const ctx = await runMetricSync(
      {
        warehouseId: "stub-warehouse",
        metricJsonPath: altPath,
        outputDir: altOut,
        rootDir: tmp,
        silent: true,
      },
      { ...io, deps, interactive: false },
    );

    expect(ctx.metricJsonPath).toBe(altPath);
    expect(ctx.outputDir).toBe(altOut);
    expect(fs.existsSync(path.join(altOut, "metric.d.ts"))).toBe(true);
    expect(fs.existsSync(path.join(altOut, "metrics.metadata.json"))).toBe(
      true,
    );
  });
});

// ── runMetricSync — failure modes ──────────────────────────────────────────

describe("runMetricSync — failure modes", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("metric-sync-failure");
    fs.mkdirSync(path.join(tmp, "config", "queries"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "config", "queries", "metric.json"),
      JSON.stringify(VALID_METRIC_JSON, null, 2),
    );
  });

  afterEach(() => cleanDir(tmp));

  it("rejects malformed JSON with malformed-config", async () => {
    fs.writeFileSync(
      path.join(tmp, "config", "queries", "metric.json"),
      "{not valid json",
    );

    const io = captureIO();
    await expect(
      runMetricSync(
        {
          warehouseId: "stub-warehouse",
          rootDir: tmp,
          silent: true,
        },
        { ...io, deps: makeDeps(), interactive: false },
      ),
    ).rejects.toMatchObject({
      code: "malformed-config",
    });
  });

  it("rejects missing metric.json with malformed-config", async () => {
    fs.unlinkSync(path.join(tmp, "config", "queries", "metric.json"));

    const io = captureIO();
    await expect(
      runMetricSync(
        {
          warehouseId: "stub-warehouse",
          rootDir: tmp,
          silent: true,
        },
        { ...io, deps: makeDeps(), interactive: false },
      ),
    ).rejects.toMatchObject({
      code: "malformed-config",
    });
  });

  it("rejects schema-invalid metric.json with malformed-config", async () => {
    fs.writeFileSync(
      path.join(tmp, "config", "queries", "metric.json"),
      JSON.stringify({ sp: { "1bad-key": { source: "x" } } }),
    );

    const io = captureIO();
    let captured: MetricSyncError | null = null;
    try {
      await runMetricSync(
        {
          warehouseId: "stub-warehouse",
          rootDir: tmp,
          silent: true,
        },
        { ...io, deps: makeDeps(), interactive: false },
      );
    } catch (err) {
      captured = err as MetricSyncError;
    }
    expect(captured).toBeInstanceOf(MetricSyncError);
    expect(captured?.code).toBe("malformed-config");
    // Stable summary line, message body varies by AJV version so we don't
    // snapshot the full error.
    expect(captured?.message).toContain("Invalid metric.json");
  });

  it("rejects metric.json with bare-string source as malformed-config", async () => {
    fs.writeFileSync(
      path.join(tmp, "config", "queries", "metric.json"),
      JSON.stringify({ sp: { revenue: "demo.public.revenue" } }),
    );

    const io = captureIO();
    await expect(
      runMetricSync(
        {
          warehouseId: "stub-warehouse",
          rootDir: tmp,
          silent: true,
        },
        { ...io, deps: makeDeps(), interactive: false },
      ),
    ).rejects.toMatchObject({
      code: "malformed-config",
    });
  });

  it("surfaces missing-fqn when the fetcher rejects with 'not found'", async () => {
    const deps = makeDeps({
      createWorkspaceDescribeFetcher: vi.fn(() => async (_fqn: string) => {
        throw new Error("TABLE_OR_VIEW_NOT_FOUND: relation does not exist");
      }),
    });

    const io = captureIO();
    let captured: MetricSyncError | null = null;
    try {
      await runMetricSync(
        {
          warehouseId: "stub-warehouse",
          rootDir: tmp,
          silent: true,
        },
        { ...io, deps, interactive: false },
      );
    } catch (err) {
      captured = err as MetricSyncError;
    }
    expect(captured?.code).toBe("missing-fqn");
    expect(captured?.fqn).toBe("demo.public.revenue");
    expect(captured?.message).toContain("demo.public.revenue");
  });

  it("surfaces warehouse-unreach with the warehouse ID embedded", async () => {
    const deps = makeDeps({
      createWorkspaceDescribeFetcher: vi.fn(() => async (_fqn: string) => {
        throw new Error(
          "connect ECONNREFUSED 127.0.0.1:443 unreachable warehouse",
        );
      }),
    });

    const io = captureIO();
    let captured: MetricSyncError | null = null;
    try {
      await runMetricSync(
        {
          warehouseId: "wh-12345",
          rootDir: tmp,
          silent: true,
        },
        { ...io, deps, interactive: false },
      );
    } catch (err) {
      captured = err as MetricSyncError;
    }
    expect(captured?.code).toBe("warehouse-unreach");
    expect(captured?.message).toContain("'wh-12345'");
  });

  it("surfaces auth-failed when the fetcher rejects with 401", async () => {
    const deps = makeDeps({
      createWorkspaceDescribeFetcher: vi.fn(() => async (_fqn: string) => {
        throw new Error("401 Unauthorized — invalid OAuth token");
      }),
    });

    const io = captureIO();
    let captured: MetricSyncError | null = null;
    try {
      await runMetricSync(
        {
          warehouseId: "wh-12345",
          rootDir: tmp,
          silent: true,
        },
        { ...io, deps, interactive: false },
      );
    } catch (err) {
      captured = err as MetricSyncError;
    }
    expect(captured?.code).toBe("auth-failed");
    expect(captured?.message).toContain("Authentication failed");
  });

  it("surfaces unknown for an unexpected error", async () => {
    const deps = makeDeps({
      createWorkspaceDescribeFetcher: vi.fn(() => async (_fqn: string) => {
        throw new Error("internal error: kernel panic");
      }),
    });

    const io = captureIO();
    let captured: MetricSyncError | null = null;
    try {
      await runMetricSync(
        {
          warehouseId: "wh-12345",
          rootDir: tmp,
          silent: true,
        },
        { ...io, deps, interactive: false },
      );
    } catch (err) {
      captured = err as MetricSyncError;
    }
    expect(captured?.code).toBe("unknown");
  });

  it("rejects --silent with no warehouse ID resolved", async () => {
    const previousEnv = process.env.DATABRICKS_WAREHOUSE_ID;
    delete process.env.DATABRICKS_WAREHOUSE_ID;

    try {
      const io = captureIO();
      await expect(
        runMetricSync(
          {
            rootDir: tmp,
            silent: true,
          },
          { ...io, deps: makeDeps(), interactive: false },
        ),
      ).rejects.toMatchObject({
        code: "warehouse-unreach",
      });
    } finally {
      if (previousEnv !== undefined) {
        process.env.DATABRICKS_WAREHOUSE_ID = previousEnv;
      }
    }
  });

  it("surfaces per-entry sync failures (parse / zero-column) as a typed error", async () => {
    // Simulates the case where DESCRIBE returned successfully but extraction
    // produced an empty bundle — without surfacing this, an empty bundle
    // would ship and the runtime fail-closed gate would 503 every request.
    const io = captureIO();
    const deps = makeDeps({
      syncMetrics: vi.fn(
        async (resolution: {
          entries: Array<{ key: string; source: string; lane: "sp" | "obo" }>;
        }) => ({
          schemas: resolution.entries.map((e) => ({
            key: e.key,
            source: e.source,
            lane: e.lane,
            measures: [],
            dimensions: [],
          })),
          failures: [
            {
              key: "revenue",
              source: "appkit_demo.public.revenue_metrics",
              reason: "DESCRIBE response yielded zero columns",
            },
          ],
        }),
      ),
    });

    await expect(
      runMetricSync(
        {
          warehouseId: "wh-x",
          rootDir: tmp,
        },
        { ...io, deps, interactive: false },
      ),
    ).rejects.toThrowError(/zero columns/);
  });
});
