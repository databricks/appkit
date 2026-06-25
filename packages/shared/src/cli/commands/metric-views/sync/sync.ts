import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cancel, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { Command } from "commander";
import {
  formatMetricViewsSourceErrors,
  validateMetricViewsSource,
} from "../validate-metric-views-source";

/**
 * Options parsed by commander for `appkit mv sync`.
 *
 * Phase 3 locks the flag surface to exactly four options and adds the
 * interactive clack flow:
 *   - `--warehouse-id` (+ `DATABRICKS_WAREHOUSE_ID` fallback)
 *   - `--metric-views-json-path` (canonical config path)
 *   - `--output-dir` (artifact output directory; replaces Phase 1's `--out-dir`)
 *   - `--no-cache` (commander negation → `cache === false` disables the
 *     metric type-generation cache)
 *
 * Phase 1's interim `--root-dir` is dropped: relative `--metric-views-json-path`
 * / `--output-dir` resolve against `process.cwd()`, mirroring how
 * `generate-types` anchors its defaults at the current directory.
 */
export interface MetricViewsSyncOptions {
  warehouseId?: string;
  /**
   * Path to metric-views.json. Default:
   * `<cwd>/config/queries/metric-views.json`. Canonical flag name in the
   * locked spec.
   */
  metricViewsJsonPath?: string;
  /** Output directory for metric-views.d.ts + metric-views.metadata.json (default: <cwd>/shared/appkit-types). */
  outputDir?: string;
  /**
   * Caching toggle. Commander's `--no-cache` sets this to `false` (and leaves it
   * `true`/absent otherwise); `cache === false` is the single signal that
   * disables the metric type-generation cache when forwarded to
   * `syncMetricViewsTypes`.
   */
  cache?: boolean;
}

/** Default filename for the metric source config (post-#433 name). */
const METRIC_VIEWS_CONFIG_FILE = "metric-views.json";

/**
 * Non-zero exit code for `appkit mv sync` failure modes. Every error mode
 * exits with this same code and a distinct, recognizable message (the failure
 * mode is identified by that message, not by a bespoke per-mode code — keeping
 * the single Phase-1 exit mechanism). The dormant (no-config) and success cases
 * take an early `return`, exiting 0 naturally.
 */
const EXIT_FAILURE = 1;

/** Resolved, absolute paths the sync run operates on. */
interface ResolvedPaths {
  /** Folder that holds metric-views.json (the appkit export reads from a folder). */
  queryFolder: string;
  /** Absolute path to metric-views.json. */
  configPath: string;
  /** Whether the config path came from an explicit `--metric-views-json-path`. */
  explicitConfigPath: boolean;
  /** Output directory for the generated artifacts. */
  outDir: string;
}

/**
 * Resolve config + output paths from the (interactive- or flag-supplied)
 * options. Relative paths resolve against `process.cwd()` (Phase 1's
 * `--root-dir` was dropped in Phase 3).
 */
function resolvePaths(options: {
  metricViewsJsonPath?: string;
  outputDir?: string;
}): ResolvedPaths {
  const cwd = process.cwd();

  // metric-views.json: --metric-views-json-path > <cwd>/config/queries/metric-views.json.
  const explicitConfigPath = options.metricViewsJsonPath !== undefined;
  const configPath = options.metricViewsJsonPath
    ? path.isAbsolute(options.metricViewsJsonPath)
      ? options.metricViewsJsonPath
      : path.resolve(cwd, options.metricViewsJsonPath)
    : path.join(cwd, "config", "queries", METRIC_VIEWS_CONFIG_FILE);

  // Output paths under shared/appkit-types — matches how generate-types
  // resolves its output directory.
  const outDir = options.outputDir
    ? path.isAbsolute(options.outputDir)
      ? options.outputDir
      : path.resolve(cwd, options.outputDir)
    : path.join(cwd, "shared", "appkit-types");

  return {
    queryFolder: path.dirname(configPath),
    configPath,
    explicitConfigPath,
    outDir,
  };
}

/**
 * The shared sync core for BOTH the interactive and non-interactive paths:
 * resolve paths → existence check (dormancy vs missing) → read + `JSON.parse`
 * → schema-validate → require warehouse → ONLY THEN dynamic-import appkit +
 * `syncMetricViewsTypes`. Reaches the appkit metric-sync core through a dynamic
 * `import("@databricks/appkit/type-generator")` — the exact pattern
 * `generate-types.ts` uses — so the `shared` CLI package carries NO static
 * dependency on `@databricks/appkit` and compiles without it.
 *
 * Validation runs entirely before the dynamic import, so a misconfigured
 * `metric-views.json` fails fast with a precise message and never touches a
 * warehouse (or even requires appkit to be installed).
 *
 * `onProgress` lets the interactive path drive a clack spinner around the
 * appkit call; the non-interactive path passes nothing (plain console logs).
 */
async function runMetricViewsSync(
  options: MetricViewsSyncOptions,
  onProgress?: { start(): void; succeed(msg: string): void; fail(): void },
): Promise<void> {
  try {
    const { queryFolder, configPath, explicitConfigPath, outDir } =
      resolvePaths(options);

    // `--metric-views-json-path` selects WHICH metric-views.json to sync, but the
    // appkit reader resolves `<queryFolder>/metric-views.json` from the folder, so
    // a differently-named file would be validated here yet never synced (appkit
    // would read a sibling metric-views.json, or none). Reject the mismatch
    // explicitly instead of silently validating one file and syncing another.
    if (
      explicitConfigPath &&
      path.basename(configPath) !== METRIC_VIEWS_CONFIG_FILE
    ) {
      console.error(
        `Error: --metric-views-json-path must point to a file named ${METRIC_VIEWS_CONFIG_FILE} (got "${path.basename(configPath)}").`,
      );
      process.exit(EXIT_FAILURE);
      return;
    }

    // Existence is checked before anything else (including the warehouse-id
    // requirement) so the dormancy invariant holds unconditionally:
    //  - DEFAULT path absent → additive path is dormant, exit 0. An opt-in
    //    project that never adopted metric views must NOT error, even without a
    //    warehouse configured.
    //  - EXPLICIT --metric-views-json-path absent → the user named a file that
    //    isn't there; that's a real error, exit non-zero.
    if (!fs.existsSync(configPath)) {
      if (explicitConfigPath) {
        console.error(`Error: metric-views.json not found at ${configPath}.`);
        process.exit(EXIT_FAILURE);
        return;
      }
      console.log(
        `No ${METRIC_VIEWS_CONFIG_FILE} found at ${configPath}. Nothing to sync.`,
      );
      return;
    }

    // Read + parse the config before touching appkit. A malformed file is a
    // user error with a precise location, not an appkit/warehouse failure.
    const rawConfig = fs.readFileSync(configPath, "utf-8");
    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(rawConfig);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${configPath} is not valid JSON: ${reason}`);
      process.exit(EXIT_FAILURE);
      return;
    }

    // Schema-validate against the canonical metricSourceSchema (single source
    // of truth) BEFORE the dynamic import. Bad FQN grammar, an unknown
    // executor, an unrecognized key, or a bad metric key fail here with the
    // `path: message` list — never as an opaque downstream error.
    const validation = validateMetricViewsSource(parsedConfig);
    if (!validation.valid) {
      console.error(`Error: invalid ${configPath}:`);
      console.error(formatMetricViewsSourceErrors(validation.errors));
      process.exit(EXIT_FAILURE);
      return;
    }

    // The warehouse is only needed once we have a valid config to sync; require
    // it here (after dormancy + validation) so a dormant/invalid project never
    // trips on a missing warehouse.
    const warehouseId =
      options.warehouseId || process.env.DATABRICKS_WAREHOUSE_ID;
    if (!warehouseId) {
      console.error(
        "Error: no warehouse ID. Pass --warehouse-id <id> or set DATABRICKS_WAREHOUSE_ID.",
      );
      process.exit(EXIT_FAILURE);
      return;
    }

    const typeGen = await import("@databricks/appkit/type-generator");

    const metricOutFile = path.join(outDir, typeGen.METRIC_TYPES_FILE);
    const metricMetadataOutFile = path.join(
      outDir,
      typeGen.METRIC_METADATA_FILE,
    );

    onProgress?.start();
    let result: Awaited<ReturnType<typeof typeGen.syncMetricViewsTypes>>;
    try {
      result = await typeGen.syncMetricViewsTypes({
        queryFolder,
        metricOutFile,
        metricMetadataOutFile,
        warehouseId,
        // `--no-cache` → cache === false disables the metric typegen cache;
        // absent/true keeps the default (cache on). Forwarded verbatim.
        cache: options.cache,
      });
    } catch (err) {
      onProgress?.fail();
      throw err;
    }

    if (result.noConfig) {
      // Defensive: the existence check above already handled the dormant case,
      // but syncMetricViewsTypes re-checks the folder, so honor its verdict too.
      onProgress?.fail();
      console.log(
        `No ${METRIC_VIEWS_CONFIG_FILE} found at ${configPath}. Nothing to sync.`,
      );
      return;
    }

    // Per-entry DESCRIBE failures (missing/unreachable FQN, type errors against
    // a reachable warehouse) come back in `failures` rather than thrown — the
    // appkit export writes permissive/degraded types and returns. Surface them
    // as a hard failure so a misconfigured FQN does not silently ship.
    if (result.failures.length > 0) {
      onProgress?.fail();
      console.error(
        `Error: ${result.failures.length} metric view(s) could not be described:`,
      );
      for (const failure of result.failures) {
        console.error(
          `  ${failure.key} (${failure.source}): ${failure.reason}`,
        );
      }
      process.exit(EXIT_FAILURE);
      return;
    }

    // Degraded-but-not-failed (e.g. a not-ready warehouse returned no schema for
    // some keys): the permissive types ARE written, so unlike `result.failures`
    // above this is a warning — not a hard failure — and the command still exits
    // 0. The degraded entries refresh on a rerun once the warehouse is available.
    const degradedKeys = result.schemas
      .filter((schema) => schema.degraded)
      .map((schema) => schema.key);
    if (degradedKeys.length > 0) {
      onProgress?.succeed(
        `Generated permissive metric types: ${metricOutFile}`,
      );
      console.warn(
        `Warning: ${degradedKeys.length} metric view(s) (${degradedKeys.join(", ")}) could not be described — the warehouse wasn't ready, so permissive types were written. Rerun \`appkit mv sync\` once the warehouse is available.`,
      );
      console.log(`Generated metric metadata: ${metricMetadataOutFile}`);
      return;
    }

    onProgress?.succeed(`Generated metric types: ${metricOutFile}`);
    console.log(`Generated metric types: ${metricOutFile}`);
    console.log(`Generated metric metadata: ${metricMetadataOutFile}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Cannot find module")
    ) {
      console.error(
        "Error: appkit mv sync is only available with @databricks/appkit installed.",
      );
      console.error("Please install @databricks/appkit to use this command.");
      process.exit(EXIT_FAILURE);
      return;
    }
    // Errors thrown by syncMetricViewsTypes — an unreachable warehouse, an auth
    // failure, or a fatal DESCRIBE setup problem (TypegenFatalError) — carry
    // their own recognizable message. Re-throw so the action wrapper prints it
    // and exits non-zero, keeping the message verbatim.
    throw error;
  }
}

/**
 * Interactive flow (mirrors `plugin create`'s `runInteractive`): `intro` →
 * `text` prompts (warehouse id, config path, output dir, each guarded by
 * `isCancel`) → `spinner` around the sync → `outro`. Each prompt's value is
 * folded back into {@link MetricViewsSyncOptions} and handed to {@link runMetricViewsSync}
 * — the SAME validation + taxonomy + appkit call the flag path uses.
 *
 * Empty answers fall through as `undefined`, so the warehouse prompt's blank
 * input still lets the `DATABRICKS_WAREHOUSE_ID` fallback apply, and blank
 * path prompts use the canonical defaults.
 */
async function runInteractive(): Promise<void> {
  intro("Sync UC Metric View types");

  // A cancelled prompt (Ctrl-C) is a graceful, non-zero exit. The explicit
  // `return` after `process.exit` keeps control flow correct under a no-op exit
  // (tests) — without it, a cancelled flow would fall through to the next
  // prompt and eventually run the sync.
  const cancelled = (): never => {
    cancel("Cancelled.");
    process.exit(1);
  };

  const warehouseId = await text({
    message: "SQL Warehouse ID",
    placeholder: process.env.DATABRICKS_WAREHOUSE_ID
      ? `${process.env.DATABRICKS_WAREHOUSE_ID} (from DATABRICKS_WAREHOUSE_ID)`
      : "1234abcd5678efgh",
    // Optional: a blank value defers to DATABRICKS_WAREHOUSE_ID (validated
    // downstream by runMetricViewsSync, which errors if neither is set).
  });
  if (isCancel(warehouseId)) return cancelled();

  const metricViewsJsonPath = await text({
    message: "Path to metric-views.json",
    placeholder: "config/queries/metric-views.json",
    // Optional: blank uses the canonical default path.
  });
  if (isCancel(metricViewsJsonPath)) return cancelled();

  const outputDir = await text({
    message: "Output directory for generated types",
    placeholder: "shared/appkit-types",
    // Optional: blank uses the canonical default output dir.
  });
  if (isCancel(outputDir)) return cancelled();

  const trimmed = (value: string | symbol): string | undefined => {
    if (typeof value !== "string") return undefined;
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  };

  const options: MetricViewsSyncOptions = {
    warehouseId: trimmed(warehouseId),
    metricViewsJsonPath: trimmed(metricViewsJsonPath),
    outputDir: trimmed(outputDir),
    // Interactive runs use the default cache behavior (cache on); --no-cache is
    // a non-interactive flag.
    cache: true,
  };

  const s = spinner();
  await runMetricViewsSync(options, {
    start: () => s.start("Describing metric views…"),
    succeed: (msg) => s.stop(msg),
    fail: () => s.stop("Failed."),
  });

  outro("Metric types synced.");
}

/**
 * Entry point for the `metric sync` action. Detection mirrors `plugin create`'s
 * interactive-vs-non-interactive split, but keys on commander's per-option value
 * SOURCE (`getOptionValueSource(name) === "cli"`) rather than presence:
 *   - NO user-provided flag (every option's source is `default`/absent) →
 *     interactive prompts.
 *   - ANY user-provided flag → the flag-driven (non-interactive) path.
 *
 * Keying on the `cli` source (not value presence) is deliberate: a
 * `DATABRICKS_WAREHOUSE_ID` env default does NOT populate any CLI option, so it
 * never forces non-interactive; and `--no-cache`'s default (`cache: true`,
 * source `default`) is correctly ignored, while an explicit `--no-cache`
 * (source `cli`) does select non-interactive.
 */
async function runMetricViewsSyncAction(
  options: MetricViewsSyncOptions,
  command: Command,
): Promise<void> {
  const FLAG_OPTION_NAMES = [
    "warehouseId",
    "metricViewsJsonPath",
    "outputDir",
    "cache",
  ] as const;
  const hasUserFlag = FLAG_OPTION_NAMES.some(
    (name) => command.getOptionValueSource(name) === "cli",
  );

  if (hasUserFlag) {
    await runMetricViewsSync(options);
  } else {
    await runInteractive();
  }
}

export const metricViewsSyncCommand = new Command("sync")
  .description(
    "Sync UC Metric View schemas: DESCRIBE every entry in metric-views.json, then emit metric-views.d.ts + metric-views.metadata.json.",
  )
  .option(
    "--warehouse-id <id>",
    "Databricks SQL Warehouse ID (overrides DATABRICKS_WAREHOUSE_ID env var)",
  )
  .option(
    "--metric-views-json-path <path>",
    "Path to metric-views.json (default: config/queries/metric-views.json)",
  )
  .option(
    "--output-dir <dir>",
    "Output directory for metric-views.d.ts and metric-views.metadata.json (default: shared/appkit-types)",
  )
  .option("--no-cache", "Disable the metric type-generation cache")
  .addHelpText(
    "after",
    `
Run with no flags for an interactive prompt; pass any flag for non-interactive mode.

Examples:
  $ appkit mv sync
  $ appkit mv sync --warehouse-id 1234abcd5678efgh
  $ appkit mv sync --warehouse-id 1234abcd5678efgh --metric-views-json-path config/queries/metric-views.json
  $ appkit mv sync --warehouse-id 1234abcd5678efgh --output-dir shared/appkit-types
  $ appkit mv sync --warehouse-id 1234abcd5678efgh --no-cache

Environment variables:
  DATABRICKS_WAREHOUSE_ID    SQL warehouse ID (used when --warehouse-id is omitted)
  DATABRICKS_HOST            Databricks workspace URL (consumed by the SDK)`,
  )
  .action((opts: MetricViewsSyncOptions, command: Command) =>
    runMetricViewsSyncAction(opts, command).catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_FAILURE);
    }),
  );
