import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from "vitest";

// --- Module mocks -----------------------------------------------------------
// vi.mock factories are hoisted above the file, so the spies they return must be
// created in a hoisted block too. Mirrors generate-types.test.ts.
const { syncMetricViewsTypes, METRIC_TYPES_FILE, METRIC_METADATA_FILE } =
  vi.hoisted(() => ({
    // The mock stands in for the appkit export: it WRITES both artifacts (so
    // the test can assert they land in the temp dir) and reports its inputs.
    syncMetricViewsTypes: vi.fn(
      async (opts: {
        queryFolder: string;
        warehouseId: string;
        metricOutFile: string;
        metricMetadataOutFile: string;
        cache?: boolean;
      }) => {
        const nodeFs = require("node:fs") as typeof import("node:fs");
        const nodePath = require("node:path") as typeof import("node:path");
        nodeFs.mkdirSync(nodePath.dirname(opts.metricOutFile), {
          recursive: true,
        });
        nodeFs.writeFileSync(opts.metricOutFile, "// metric.d.ts\n");
        nodeFs.writeFileSync(opts.metricMetadataOutFile, "{}\n");
        // Annotate the array element types so the inferred return type is wide
        // enough for `mockResolvedValueOnce` overrides that populate `failures`
        // (an empty literal would otherwise infer `never[]`).
        const schemas: Array<{ key: string; source: string; lane: string }> = [
          { key: "revenue", source: "demo.sales.revenue", lane: "sp" },
        ];
        const failures: Array<{
          key: string;
          source: string;
          reason: string;
          transient: boolean;
        }> = [];
        return {
          metricOutFile: opts.metricOutFile,
          metricMetadataOutFile: opts.metricMetadataOutFile,
          schemas,
          failures,
          noConfig: false,
        };
      },
    ),
    METRIC_TYPES_FILE: "metric.d.ts",
    METRIC_METADATA_FILE: "metrics.metadata.json",
  }));

// The library type-generator is an optional/ambient module; mock it so the
// command's `await import("@databricks/appkit/type-generator")` resolves to
// spies and never touches a warehouse.
vi.mock("@databricks/appkit/type-generator", () => ({
  syncMetricViewsTypes,
  METRIC_TYPES_FILE,
  METRIC_METADATA_FILE,
}));

// --- @clack/prompts mock ----------------------------------------------------
// Drive the interactive path deterministically: each `text` prompt returns the
// next queued answer; `isCancel` recognizes the shared CANCEL symbol so a queued
// cancel triggers the graceful-exit branch. intro/outro/cancel/spinner are
// no-op spies (the spinner object exposes start/stop).
const clackMocks = vi.hoisted(() => {
  const CANCEL = Symbol("clack:cancel");
  return {
    CANCEL,
    // Answers consumed in prompt order (warehouse id, config path, output dir).
    textAnswers: [] as Array<string | symbol>,
    text: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    spinnerStart: vi.fn(),
    spinnerStop: vi.fn(),
  };
});

vi.mock("@clack/prompts", () => ({
  intro: clackMocks.intro,
  outro: clackMocks.outro,
  cancel: clackMocks.cancel,
  isCancel: (value: unknown) => value === clackMocks.CANCEL,
  text: (...args: unknown[]) => {
    clackMocks.text(...args);
    return Promise.resolve(
      clackMocks.textAnswers.length > 0
        ? clackMocks.textAnswers.shift()
        : undefined,
    );
  },
  spinner: () => ({
    start: clackMocks.spinnerStart,
    stop: clackMocks.spinnerStop,
  }),
}));

import { metricViewsSyncCommand } from "./sync";

/**
 * Drive the real commander command the way the bin does. `metricViewsSyncCommand`
 * is a module-level singleton, so commander retains option values parsed by a
 * previous call (absent options are NOT reset between `parseAsync` calls);
 * clear that stored state first so each invocation parses from a clean slate.
 * Resetting `_optionValueSources` to `{}` also clears the per-option `default`
 * source bookkeeping, so a no-flag parse leaves every source `undefined` — the
 * interactive-detection check keys on the `cli` source, so that reads correctly
 * as "no user flag".
 */
async function runCli(args: string[]): Promise<void> {
  const cmd = metricViewsSyncCommand as unknown as {
    _optionValues: Record<string, unknown>;
    _optionValueSources: Record<string, unknown>;
  };
  cmd._optionValues = {};
  cmd._optionValueSources = {};
  await metricViewsSyncCommand.parseAsync(args, { from: "user" });
}

describe("appkit mv sync", () => {
  let tmpRoot: string;
  let queryFolder: string;
  let consoleLog: Mock;
  let consoleError: Mock;
  let originalCwd: string;
  const prevWarehouse = process.env.DATABRICKS_WAREHOUSE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    clackMocks.textAnswers = [];
    originalCwd = process.cwd();
    tmpRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "metric-sync-cli-")),
    );
    queryFolder = path.join(tmpRoot, "config", "queries");
    fs.mkdirSync(queryFolder, { recursive: true });
    delete process.env.DATABRICKS_WAREHOUSE_ID;
    // `--root-dir` was dropped in Phase 3; the command resolves cwd-relative
    // paths against process.cwd(), so anchor cwd at the temp root (mirrors
    // promote.test.ts).
    process.chdir(tmpRoot);

    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {}) as Mock;
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {}) as Mock;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (prevWarehouse === undefined) {
      delete process.env.DATABRICKS_WAREHOUSE_ID;
    } else {
      process.env.DATABRICKS_WAREHOUSE_ID = prevWarehouse;
    }
  });

  const writeConfig = () => {
    fs.writeFileSync(
      path.join(queryFolder, "metric-views.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "demo.sales.revenue" } },
      }),
    );
  };

  // --- Non-interactive: flag parsing + option mapping ------------------------

  test("calls the appkit entry with resolved paths and writes both artifacts", async () => {
    writeConfig();

    await runCli(["--warehouse-id", "wh-123"]);

    const expectedMetricOut = path.join(
      tmpRoot,
      "shared",
      "appkit-types",
      "metric.d.ts",
    );
    const expectedMetadataOut = path.join(
      tmpRoot,
      "shared",
      "appkit-types",
      "metrics.metadata.json",
    );

    // The appkit entry was called once with the resolved options. Cache is the
    // commander default; after the test harness reset it is undefined (no flag,
    // source cleared) — i.e. caching stays ON downstream.
    expect(syncMetricViewsTypes).toHaveBeenCalledTimes(1);
    expect(syncMetricViewsTypes).toHaveBeenCalledWith({
      queryFolder,
      warehouseId: "wh-123",
      metricOutFile: expectedMetricOut,
      metricMetadataOutFile: expectedMetadataOut,
      cache: undefined,
    });

    // Both artifacts landed in the temp dir.
    expect(fs.existsSync(expectedMetricOut)).toBe(true);
    expect(fs.existsSync(expectedMetadataOut)).toBe(true);
  });

  test("falls back to DATABRICKS_WAREHOUSE_ID when --warehouse-id is omitted (and stays non-interactive via another flag)", async () => {
    writeConfig();
    process.env.DATABRICKS_WAREHOUSE_ID = "wh-env";

    // Pass --output-dir so the env var alone doesn't have to force
    // non-interactive (it must not — see the dedicated interactive test).
    await runCli(["--output-dir", "shared/appkit-types"]);

    expect(syncMetricViewsTypes).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseId: "wh-env" }),
    );
  });

  test("honors --metric-views-json-path / --output-dir overrides for path resolution", async () => {
    const customConfigDir = path.join(tmpRoot, "custom", "cfg");
    fs.mkdirSync(customConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(customConfigDir, "metric-views.json"),
      JSON.stringify({ metricViews: {} }),
    );

    await runCli([
      "--warehouse-id",
      "wh-123",
      "--metric-views-json-path",
      "custom/cfg/metric-views.json",
      "--output-dir",
      "build/types",
    ]);

    expect(syncMetricViewsTypes).toHaveBeenCalledWith({
      queryFolder: customConfigDir,
      warehouseId: "wh-123",
      metricOutFile: path.join(tmpRoot, "build", "types", "metric.d.ts"),
      metricMetadataOutFile: path.join(
        tmpRoot,
        "build",
        "types",
        "metrics.metadata.json",
      ),
      cache: undefined,
    });
  });

  test("absolute --metric-views-json-path / --output-dir are used as-is", async () => {
    const absConfig = path.join(
      tmpRoot,
      "config",
      "queries",
      "metric-views.json",
    );
    writeConfig();
    const absOut = path.join(tmpRoot, "abs-out");

    await runCli([
      "--warehouse-id",
      "wh-123",
      "--metric-views-json-path",
      absConfig,
      "--output-dir",
      absOut,
    ]);

    expect(syncMetricViewsTypes).toHaveBeenCalledWith(
      expect.objectContaining({
        queryFolder: path.dirname(absConfig),
        metricOutFile: path.join(absOut, "metric.d.ts"),
        metricMetadataOutFile: path.join(absOut, "metrics.metadata.json"),
      }),
    );
  });

  test("friendly message + no appkit call when metric-views.json is absent", async () => {
    await runCli(["--warehouse-id", "wh-123"]);

    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
    const logged = consoleLog.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("Nothing to sync");
  });

  test("appkit absent: recognizable error message + non-zero exit", async () => {
    writeConfig();
    // Model the dynamic import failing as it does when @databricks/appkit
    // isn't installed.
    syncMetricViewsTypes.mockRejectedValueOnce(
      new Error("Cannot find module '@databricks/appkit/type-generator'"),
    );

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    await runCli(["--warehouse-id", "wh-123"]);

    const errored = consoleError.mock.calls.flat().map(String).join("\n");
    expect(errored).toContain(
      "appkit mv sync is only available with @databricks/appkit installed",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  // --- --no-cache propagation ------------------------------------------------

  test("--no-cache forwards cache: false to syncMetricViewsTypes", async () => {
    writeConfig();

    await runCli(["--warehouse-id", "wh-123", "--no-cache"]);

    expect(syncMetricViewsTypes).toHaveBeenCalledWith(
      expect.objectContaining({ cache: false }),
    );
  });

  test("without --no-cache, cache is not disabled (default ON downstream)", async () => {
    writeConfig();

    await runCli(["--warehouse-id", "wh-123"]);

    const call = syncMetricViewsTypes.mock.calls[0][0] as { cache?: boolean };
    // Either undefined (harness reset clears the default source) or true (live
    // commander default) — the load-bearing invariant is that it is NOT false.
    expect(call.cache).not.toBe(false);
  });

  // --- Phase 2: error taxonomy ------------------------------------------------
  // Every error mode exits non-zero (1) with a distinct, recognizable message.
  // The command always `return`s right after `process.exit`, so a no-op exit
  // spy lets execution stop cleanly and we assert the captured code + message.

  /**
   * Drive the CLI with `process.exit` spied to a no-op (the command returns
   * immediately after calling it), returning the spy so the test can assert the
   * exit code and the captured stderr.
   */
  async function runCliCapturingExit(args: string[]): Promise<Mock> {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never) as unknown as Mock;
    await runCli(args);
    return exitSpy;
  }

  const erroredText = () =>
    consoleError.mock.calls.flat().map(String).join("\n");

  test("explicit --metric-views-json-path to a missing file: non-zero + recognizable message", async () => {
    const missing = path.join(tmpRoot, "nowhere", "metric-views.json");

    const exitSpy = await runCliCapturingExit([
      "--warehouse-id",
      "wh-123",
      "--metric-views-json-path",
      missing,
    ]);

    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(erroredText()).toContain("metric-views.json not found");
  });

  test("explicit --metric-views-json-path with a non-metric-views.json basename: rejected before syncing", async () => {
    // A valid config that EXISTS but is not named metric-views.json. The appkit
    // reader resolves `<folder>/metric-views.json`, so without the basename guard
    // the CLI would validate this file but sync a different (sibling/absent) one.
    const customDir = path.join(tmpRoot, "custom");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, "my-config.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "demo.sales.revenue" } },
      }),
    );

    const exitSpy = await runCliCapturingExit([
      "--warehouse-id",
      "wh-123",
      "--metric-views-json-path",
      "custom/my-config.json",
    ]);

    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(erroredText()).toContain(
      "must point to a file named metric-views.json",
    );
  });

  test("malformed JSON: non-zero + 'not valid JSON' message, never imports appkit", async () => {
    fs.writeFileSync(
      path.join(queryFolder, "metric-views.json"),
      "{ this is not json",
    );

    const exitSpy = await runCliCapturingExit(["--warehouse-id", "wh-123"]);

    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(erroredText()).toContain("is not valid JSON");
  });

  test("schema-invalid config (bad FQN): non-zero + path:message list, never imports appkit", async () => {
    fs.writeFileSync(
      path.join(queryFolder, "metric-views.json"),
      // Two-part FQN — fails the three-part UC FQN grammar.
      JSON.stringify({ metricViews: { revenue: { source: "main.cm" } } }),
    );

    const exitSpy = await runCliCapturingExit(["--warehouse-id", "wh-123"]);

    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errored = erroredText();
    expect(errored).toContain("invalid");
    // Humanized path of the failing field.
    expect(errored).toContain("metricViews.revenue.source");
  });

  test("schema-invalid config (unknown executor): non-zero + path:message list", async () => {
    fs.writeFileSync(
      path.join(queryFolder, "metric-views.json"),
      JSON.stringify({
        metricViews: { revenue: { source: "main.a.cm", executor: "robot" } },
      }),
    );

    const exitSpy = await runCliCapturingExit(["--warehouse-id", "wh-123"]);

    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(erroredText()).toContain("metricViews.revenue.executor");
  });

  test("missing warehouse id (after a valid config): non-zero + recognizable message", async () => {
    writeConfig();
    // No --warehouse-id and no DATABRICKS_WAREHOUSE_ID (cleared in beforeEach).
    // Pass --output-dir so the run is non-interactive (no flag → interactive).

    const exitSpy = await runCliCapturingExit([
      "--output-dir",
      "shared/appkit-types",
    ]);

    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(erroredText()).toContain("no warehouse ID");
  });

  test("absent DEFAULT config with no warehouse id: still exits 0 (dormancy invariant)", async () => {
    // No config file, no warehouse id — the additive path must stay dormant and
    // NOT error on the missing warehouse. Pass a flag so this stays
    // non-interactive (the dormancy decision is path-independent).
    const exitSpy = await runCliCapturingExit([
      "--output-dir",
      "shared/appkit-types",
    ]);

    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
    // Dormancy takes the early-return path, so exit() is never called at all.
    expect(exitSpy).not.toHaveBeenCalled();
    const logged = consoleLog.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("Nothing to sync");
  });

  test("unreachable warehouse / auth failure (syncMetricViewsTypes throws): non-zero + message surfaced", async () => {
    writeConfig();
    syncMetricViewsTypes.mockRejectedValueOnce(
      new Error("warehouse wh-123 is unreachable: connection refused"),
    );

    const exitSpy = await runCliCapturingExit(["--warehouse-id", "wh-123"]);

    expect(syncMetricViewsTypes).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The action wrapper prints the thrown error's message verbatim.
    expect(erroredText()).toContain(
      "warehouse wh-123 is unreachable: connection refused",
    );
  });

  test("per-entry DESCRIBE failure (unreachable FQN): non-zero + lists the failed metric", async () => {
    writeConfig();
    // The appkit export writes degraded types and returns `failures` rather
    // than throwing for a missing/unreachable metric view FQN.
    syncMetricViewsTypes.mockResolvedValueOnce({
      metricOutFile: path.join(
        tmpRoot,
        "shared",
        "appkit-types",
        "metric.d.ts",
      ),
      metricMetadataOutFile: path.join(
        tmpRoot,
        "shared",
        "appkit-types",
        "metrics.metadata.json",
      ),
      schemas: [],
      failures: [
        {
          key: "revenue",
          source: "demo.sales.revenue",
          reason: "TABLE_OR_VIEW_NOT_FOUND",
          transient: false,
        },
      ],
      noConfig: false,
    });

    const exitSpy = await runCliCapturingExit(["--warehouse-id", "wh-123"]);

    expect(syncMetricViewsTypes).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errored = erroredText();
    expect(errored).toContain("could not be described");
    expect(errored).toContain("revenue");
    expect(errored).toContain("TABLE_OR_VIEW_NOT_FOUND");
  });

  // --- Phase 3: interactive flow ----------------------------------------------

  test("no flags → interactive: prompts fire and resolved values reach syncMetricViewsTypes", async () => {
    writeConfig();
    // Answers in prompt order: warehouse id, config path (blank → default),
    // output dir (blank → default).
    clackMocks.textAnswers = ["wh-interactive", "", ""];

    await runCli([]);

    // intro/outro + three text prompts fired.
    expect(clackMocks.intro).toHaveBeenCalledTimes(1);
    expect(clackMocks.text).toHaveBeenCalledTimes(3);
    expect(clackMocks.outro).toHaveBeenCalledTimes(1);
    // Spinner wrapped the sync.
    expect(clackMocks.spinnerStart).toHaveBeenCalledTimes(1);
    expect(clackMocks.spinnerStop).toHaveBeenCalledTimes(1);

    // The interactive answer reached the appkit entry; blank path answers fell
    // back to the canonical defaults (cwd-anchored).
    expect(syncMetricViewsTypes).toHaveBeenCalledWith({
      queryFolder,
      warehouseId: "wh-interactive",
      metricOutFile: path.join(
        tmpRoot,
        "shared",
        "appkit-types",
        "metric.d.ts",
      ),
      metricMetadataOutFile: path.join(
        tmpRoot,
        "shared",
        "appkit-types",
        "metrics.metadata.json",
      ),
      cache: true,
    });
  });

  test("interactive: a non-blank config path / output dir answer is honored", async () => {
    const customConfigDir = path.join(tmpRoot, "alt", "cfg");
    fs.mkdirSync(customConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(customConfigDir, "metric-views.json"),
      JSON.stringify({ metricViews: {} }),
    );
    clackMocks.textAnswers = [
      "wh-interactive",
      "alt/cfg/metric-views.json",
      "alt/out",
    ];

    await runCli([]);

    expect(syncMetricViewsTypes).toHaveBeenCalledWith(
      expect.objectContaining({
        queryFolder: customConfigDir,
        warehouseId: "wh-interactive",
        metricOutFile: path.join(tmpRoot, "alt", "out", "metric.d.ts"),
      }),
    );
  });

  test("interactive: env var alone does NOT force non-interactive (prompts still run)", async () => {
    writeConfig();
    process.env.DATABRICKS_WAREHOUSE_ID = "wh-env";
    // Blank warehouse answer → falls back to the env var downstream.
    clackMocks.textAnswers = ["", "", ""];

    await runCli([]);

    expect(clackMocks.intro).toHaveBeenCalledTimes(1);
    expect(clackMocks.text).toHaveBeenCalledTimes(3);
    expect(syncMetricViewsTypes).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseId: "wh-env" }),
    );
  });

  test("interactive cancel (first prompt): graceful cancel + non-zero exit, no appkit call", async () => {
    writeConfig();
    // First prompt returns the cancel symbol.
    clackMocks.textAnswers = [clackMocks.CANCEL];

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never) as unknown as Mock;

    await runCli([]);

    expect(clackMocks.cancel).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
  });

  test("interactive cancel (later prompt): graceful cancel + non-zero exit", async () => {
    writeConfig();
    // First answer ok, second prompt cancels.
    clackMocks.textAnswers = ["wh-1", clackMocks.CANCEL];

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never) as unknown as Mock;

    await runCli([]);

    expect(clackMocks.cancel).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(syncMetricViewsTypes).not.toHaveBeenCalled();
  });
});
