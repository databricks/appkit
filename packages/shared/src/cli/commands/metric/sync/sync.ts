import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cancel, intro, isCancel, outro, text } from "@clack/prompts";
import { Command } from "commander";
import {
  formatMetricSourceErrors,
  validateMetricSource,
} from "./validate-metric-source";

/**
 * Recognizable error categories surfaced from `syncMetrics()` and the CLI's
 * preflight checks. The taxonomy maps 1:1 onto exit codes so wrappers
 * (CI scripts, pre-commit hooks) can branch on the failure mode.
 *
 * Mapping:
 *   missing-fqn       → 1   "Metric view '<fqn>' not found or not accessible"
 *   warehouse-unreach → 2   "Could not reach SQL warehouse '<id>'"
 *   malformed-config  → 3   "Invalid metric.json"
 *   auth-failed       → 4   "Authentication failed"
 *   unknown           → 5   catch-all
 */
export type MetricSyncErrorCode =
  | "missing-fqn"
  | "warehouse-unreach"
  | "malformed-config"
  | "auth-failed"
  | "unknown";

const EXIT_CODE_BY_CATEGORY: Record<MetricSyncErrorCode, number> = {
  "missing-fqn": 1,
  "warehouse-unreach": 2,
  "malformed-config": 3,
  "auth-failed": 4,
  unknown: 5,
};

/**
 * Typed error wrapper used by the CLI to bubble a recognizable failure mode
 * (and its associated exit code) up from helper functions to the command's
 * top-level catch.
 */
export class MetricSyncError extends Error {
  readonly code: MetricSyncErrorCode;
  readonly fqn?: string;

  constructor(code: MetricSyncErrorCode, message: string, fqn?: string) {
    super(message);
    this.name = "MetricSyncError";
    this.code = code;
    if (fqn !== undefined) this.fqn = fqn;
  }
}

/**
 * Classify an arbitrary error thrown by the DescribeFetcher (i.e. the
 * Statement Execution API call inside `createWorkspaceDescribeFetcher`) into
 * a recognizable {@link MetricSyncErrorCode}.
 *
 * The classification is intentionally string-shaped (no SDK type imports)
 * because:
 *   - the CLI runs as a thin wrapper and we don't want to pull the Databricks
 *     SDK into the shared CLI package's hot path;
 *   - the error shapes are fluid across SDK releases — matching on substrings
 *     of the message gives us a stable contract even when the SDK shifts.
 *
 * The resulting categorization is conservative: when nothing matches we fall
 * through to "unknown" so the catch-all exit code (5) carries the original
 * message verbatim. Callers should always preserve the underlying message in
 * stderr — the category is just a routing key.
 */
export function classifyFetchError(err: Error, fqn: string): MetricSyncError {
  const msg = (err.message ?? "").toLowerCase();

  // Auth failure signals — these come from the SDK's bearer/OAuth flows or
  // from the workspace returning 401/403 directly. Match before the more
  // generic "not found" / "unreachable" buckets so an auth-flavored 403
  // doesn't get bucketed as warehouse-unreach.
  if (
    msg.includes("unauthorized") ||
    msg.includes("authentication") ||
    msg.includes("403") ||
    msg.includes("401") ||
    msg.includes("forbidden") ||
    msg.includes("invalid_grant") ||
    (msg.includes("token") &&
      (msg.includes("expired") || msg.includes("invalid")))
  ) {
    return new MetricSyncError(
      "auth-failed",
      `Authentication failed: ${err.message}`,
      fqn,
    );
  }

  // Missing FQN signals — a SQL "table not found" / "doesn't exist" comes
  // back as a FAILED statement, but if the SDK throws on a 404-style HTTP
  // we catch it here. Match on the FQN word itself when present.
  if (
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    msg.includes("doesn't exist") ||
    msg.includes("no such table")
  ) {
    return new MetricSyncError(
      "missing-fqn",
      `Metric view '${fqn}' not found or not accessible: ${err.message}`,
      fqn,
    );
  }

  // Warehouse-reach signals — connection failures, host unreachable, timeouts.
  // The warehouse ID itself isn't part of the message, so we can't echo it
  // here; the caller appends it when constructing the final message.
  if (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("unreachable") ||
    (msg.includes("warehouse") && msg.includes("not"))
  ) {
    return new MetricSyncError(
      "warehouse-unreach",
      `Could not reach SQL warehouse: ${err.message}`,
      fqn,
    );
  }

  return new MetricSyncError("unknown", err.message, fqn);
}

/**
 * Read and parse `metric.json` from a path. Throws a {@link MetricSyncError}
 * with `malformed-config` on missing/parse errors so the top-level catch can
 * route to the right exit code.
 */
function readMetricJson(metricJsonPath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(metricJsonPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MetricSyncError(
      "malformed-config",
      `Could not read metric.json at ${metricJsonPath}: ${msg}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MetricSyncError(
      "malformed-config",
      `Failed to parse metric.json at ${metricJsonPath}: ${msg}`,
    );
  }
}

/**
 * Resolve the metric.json path. Honors --metric-json-path, otherwise looks at
 * the conventional `<rootDir>/config/queries/metric.json` location.
 */
function resolveMetricJsonPath(rootDir: string, override?: string): string {
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.resolve(rootDir, override);
  }
  return path.resolve(rootDir, "config", "queries", "metric.json");
}

/**
 * Resolve the output directory for the generated `.d.ts` and metadata bundle.
 * Defaults to `<rootDir>/shared/appkit-types` to match the Vite-plugin output
 * convention (`appKitTypesPlugin` writes to that location by default).
 */
function resolveOutputDir(rootDir: string, override?: string): string {
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.resolve(rootDir, override);
  }
  return path.resolve(rootDir, "shared", "appkit-types");
}

/**
 * Inputs produced by `runMetricSync`'s preflight phase: everything the
 * implementation needs after env vars / flags / prompts have been resolved.
 *
 * Exported (along with `runMetricSync`) for snapshot tests that want to
 * inject deterministic seams.
 */
export interface MetricSyncContext {
  warehouseId: string;
  metricJsonPath: string;
  outputDir: string;
  metricTypesPath: string;
  metricMetadataPath: string;
}

/**
 * Minimal column-metadata shape — mirrors `MetricColumnMetadata` from
 * `@databricks/appkit/type-generator`. Kept here (rather than imported) so
 * the shared CLI package compiles even when @databricks/appkit isn't built.
 */
export interface MetricSyncColumnMetadata {
  name: string;
  type: string;
  isMeasure: boolean;
  description?: string;
  displayName?: string;
  format?: string;
  timeGrains?: string[];
}

/**
 * Minimal MetricSchema shape — mirrors `MetricSchema` from the type-generator
 * package. Tests construct stubs with empty `measures` / `dimensions` arrays,
 * and the structural compatibility carries through to the real implementation.
 */
export interface MetricSyncSchema {
  key: string;
  source: string;
  lane: "sp" | "obo";
  measures: MetricSyncColumnMetadata[];
  dimensions: MetricSyncColumnMetadata[];
}

/**
 * The subset of `@databricks/appkit/type-generator` that the CLI consumes.
 * Defined as a structural interface so tests can substitute a mock without
 * loading the full ESM module graph (which would require `@databricks/appkit`
 * to be built before tests run).
 */
export interface MetricSyncDependencies {
  syncMetrics: (
    resolution: {
      entries: Array<{ key: string; source: string; lane: "sp" | "obo" }>;
    },
    fetcher: (fqn: string) => Promise<unknown>,
  ) => Promise<MetricSyncSchema[]>;
  resolveMetricConfig: (config: unknown) => {
    entries: Array<{ key: string; source: string; lane: "sp" | "obo" }>;
  };
  createWorkspaceDescribeFetcher: (
    warehouseId: string,
  ) => (fqn: string) => Promise<unknown>;
  generateMetricTypeDeclarations: (schemas: MetricSyncSchema[]) => string;
  generateMetricsMetadataJson: (schemas: MetricSyncSchema[]) => string;
  metricTypesFile: string;
  metricMetadataFile: string;
}

/**
 * Lazy-load `@databricks/appkit/type-generator`. Mirrors the dynamic-import
 * pattern in `generate-types.ts` so the CLI does not hard-depend on the
 * appkit package being installed (the published `appkit` CLI does, but the
 * raw `shared` CLI package needs to compile cleanly without it).
 */
async function loadDefaultDependencies(): Promise<MetricSyncDependencies> {
  try {
    const mod = await import("@databricks/appkit/type-generator");
    return {
      syncMetrics: mod.syncMetrics,
      resolveMetricConfig:
        mod.resolveMetricConfig as MetricSyncDependencies["resolveMetricConfig"],
      createWorkspaceDescribeFetcher: mod.createWorkspaceDescribeFetcher,
      generateMetricTypeDeclarations: mod.generateMetricTypeDeclarations,
      generateMetricsMetadataJson: mod.generateMetricsMetadataJson,
      metricTypesFile: mod.METRIC_TYPES_FILE,
      metricMetadataFile: mod.METRIC_METADATA_FILE,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      throw new MetricSyncError(
        "unknown",
        "The 'metric sync' command requires @databricks/appkit. Install it to use this command.",
      );
    }
    throw err;
  }
}

/**
 * The fully-resolved set of flag/env/prompt inputs the command needs.
 *
 * `metricJsonPath` and `outputDir` are required (env-var-or-flag-or-prompt
 * resolved); `warehouseId` is also required because `syncMetrics()` cannot
 * issue the DESCRIBE without it.
 */
interface ResolvedInputs {
  warehouseId: string;
  metricJsonPath: string;
  outputDir: string;
  rootDir: string;
}

/**
 * Resolve inputs from the priority chain: explicit flags > env vars > interactive
 * prompts. Matches the convention used by `plugin sync` and `plugin add-resource`
 * — no prompt fires when the value is already known via flag or env.
 *
 * In `--silent` / `--json` modes we skip prompts entirely and surface a
 * malformed-config error if a required field is unresolved (the wrapper script
 * shouldn't see TTY prompts).
 */
async function resolveInputs(
  options: MetricSyncFlags,
  rootDir: string,
  silent: boolean,
): Promise<ResolvedInputs> {
  // Warehouse ID: --warehouse-id > DATABRICKS_WAREHOUSE_ID env var > prompt
  let warehouseId =
    options.warehouseId ?? process.env.DATABRICKS_WAREHOUSE_ID ?? "";

  // metric.json path: --metric-json-path > <rootDir>/config/queries/metric.json
  let metricJsonPath = resolveMetricJsonPath(rootDir, options.metricJsonPath);

  // Output dir: --output-dir > <rootDir>/shared/appkit-types
  const outputDir = resolveOutputDir(rootDir, options.outputDir);

  if (silent) {
    if (!warehouseId) {
      throw new MetricSyncError(
        "warehouse-unreach",
        "No warehouse ID. Set DATABRICKS_WAREHOUSE_ID, pass --warehouse-id <id>, or run interactively.",
      );
    }
    return { warehouseId, metricJsonPath, outputDir, rootDir };
  }

  // Interactive: only prompt for fields that weren't already resolved.
  if (!warehouseId) {
    const answer = await text({
      message: "Databricks SQL Warehouse ID?",
      placeholder: "e.g. 1234abcd5678efgh",
      validate(value) {
        if (!value || value.trim().length === 0) {
          return "Warehouse ID is required";
        }
        return undefined;
      },
    });
    if (isCancel(answer)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    warehouseId = (answer as string).trim();
  }

  if (!options.metricJsonPath) {
    // Only prompt if the conventional location does not exist; otherwise we
    // assume the user meant the default and proceed without nagging.
    if (!fs.existsSync(metricJsonPath)) {
      const answer = await text({
        message: "Path to metric.json?",
        placeholder: "config/queries/metric.json",
        initialValue: path.relative(rootDir, metricJsonPath),
        validate(value) {
          if (!value || value.trim().length === 0) {
            return "metric.json path is required";
          }
          return undefined;
        },
      });
      if (isCancel(answer)) {
        cancel("Cancelled.");
        process.exit(0);
      }
      const resolved = (answer as string).trim();
      metricJsonPath = path.isAbsolute(resolved)
        ? resolved
        : path.resolve(rootDir, resolved);
    }
  }

  if (!options.outputDir) {
    // Use the default — no prompt unless the user explicitly opts in via flag.
    // Mirroring `generate-types.ts`'s convention.
  }

  return { warehouseId, metricJsonPath, outputDir, rootDir };
}

/**
 * CLI flags accepted by `appkit metric sync`. Exposed for test wiring.
 */
export interface MetricSyncFlags {
  warehouseId?: string;
  metricJsonPath?: string;
  outputDir?: string;
  rootDir?: string;
  silent?: boolean;
  json?: boolean;
}

/**
 * The full implementation of `appkit metric sync`. Pure-ish: takes a `deps`
 * seam so tests can inject a mock {@link MetricSyncDependencies} and a mock
 * console writer. Production wires {@link loadDefaultDependencies} and
 * `console.log` / `console.error`.
 *
 * Design notes:
 *   - We deliberately do **not** start the dependency load until after the
 *     metric.json path / schema validation step. This keeps the CLI usable
 *     for "did I write a valid metric.json?" checks even in environments
 *     where `@databricks/appkit` is missing.
 *   - `syncMetrics()` is tolerant by design (it returns empty schemas on a
 *     per-entry fetch error). To surface those errors at the CLI seam, we
 *     wrap the fetcher to capture the first failure and re-throw a typed
 *     {@link MetricSyncError}; subsequent entries are skipped.
 */
export async function runMetricSync(
  options: MetricSyncFlags,
  io: {
    log: (msg: string) => void;
    error: (msg: string) => void;
    deps?: MetricSyncDependencies;
    interactive?: boolean;
  },
): Promise<MetricSyncContext> {
  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : process.cwd();
  const silent = Boolean(options.silent || options.json);
  const interactive = io.interactive ?? !silent;

  if (interactive) {
    intro("Sync metric-view types");
  }

  const inputs = await resolveInputs(options, rootDir, !interactive);

  // Step 1: Read + validate metric.json against the JSON Schema.
  const parsed = readMetricJson(inputs.metricJsonPath);
  const schemaResult = validateMetricSource(parsed);
  if (!schemaResult.valid || !schemaResult.config) {
    const details = schemaResult.errors?.length
      ? formatMetricSourceErrors(schemaResult.errors)
      : "(no validator output)";
    throw new MetricSyncError(
      "malformed-config",
      `Invalid metric.json at ${inputs.metricJsonPath}:\n${details}`,
    );
  }

  // Step 2: Load deps (or use the injected seam) and resolve the config into
  // a MetricConfigResolution. `resolveMetricConfig` performs the additional
  // structural checks the JSON Schema can't express (duplicate keys across
  // lanes, unknown fields). It throws plain Error; we re-shape into
  // malformed-config so the CLI surfaces the right exit code.
  const deps = io.deps ?? (await loadDefaultDependencies());

  let resolution: ReturnType<MetricSyncDependencies["resolveMetricConfig"]>;
  try {
    resolution = deps.resolveMetricConfig(schemaResult.config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MetricSyncError(
      "malformed-config",
      `Invalid metric.json at ${inputs.metricJsonPath}: ${msg}`,
    );
  }

  if (resolution.entries.length === 0) {
    if (!silent) {
      io.log("No metric entries found. Nothing to sync.");
    }
    if (interactive) {
      outro("Done.");
    }
    return {
      warehouseId: inputs.warehouseId,
      metricJsonPath: inputs.metricJsonPath,
      outputDir: inputs.outputDir,
      metricTypesPath: path.join(inputs.outputDir, deps.metricTypesFile),
      metricMetadataPath: path.join(inputs.outputDir, deps.metricMetadataFile),
    };
  }

  // Step 3: Build a fetcher that classifies the first failure into a typed
  // MetricSyncError. We can't rely on `syncMetrics()` to throw — it captures
  // and continues — so we wrap before passing it in. Only the *first* failure
  // wins so the surfaced exit code reflects the earliest problem the user
  // hit (subsequent entries are best-effort and may show different symptoms).
  const baseFetcher = deps.createWorkspaceDescribeFetcher(inputs.warehouseId);
  let firstFailure: MetricSyncError | null = null;
  const wrappedFetcher: (fqn: string) => Promise<unknown> = async (fqn) => {
    try {
      return await baseFetcher(fqn);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (firstFailure === null) {
        const classified = classifyFetchError(e, fqn);
        // Refine warehouse-unreach to include the warehouse ID in the message
        // (the SDK's error doesn't carry it).
        firstFailure =
          classified.code === "warehouse-unreach"
            ? new MetricSyncError(
                "warehouse-unreach",
                `Could not reach SQL warehouse '${inputs.warehouseId}': ${e.message}`,
                fqn,
              )
            : classified;
      }
      throw e;
    }
  };

  if (!silent) {
    io.log(
      `Syncing ${resolution.entries.length} metric(s) from ${path.relative(rootDir, inputs.metricJsonPath)} via warehouse ${inputs.warehouseId}...`,
    );
  }

  const schemas = await deps.syncMetrics(resolution, wrappedFetcher);

  // If any entry's fetch failed, surface the first failure as a typed error.
  // We deliberately defer this until after `syncMetrics()` returns so the
  // emitted artifact (if we choose to emit it) reflects what we know.
  if (firstFailure) {
    throw firstFailure;
  }

  // Step 4: Emit artifacts. `outputDir` is created (recursively) on first use.
  fs.mkdirSync(inputs.outputDir, { recursive: true });

  const metricTypesPath = path.join(inputs.outputDir, deps.metricTypesFile);
  const metricMetadataPath = path.join(
    inputs.outputDir,
    deps.metricMetadataFile,
  );

  fs.writeFileSync(
    metricTypesPath,
    deps.generateMetricTypeDeclarations(schemas),
    "utf-8",
  );
  fs.writeFileSync(
    metricMetadataPath,
    deps.generateMetricsMetadataJson(schemas),
    "utf-8",
  );

  if (!silent) {
    io.log(`✓ Wrote ${path.relative(rootDir, metricTypesPath)}`);
    io.log(`✓ Wrote ${path.relative(rootDir, metricMetadataPath)}`);
  }

  if (interactive) {
    outro(`Synced ${schemas.length} metric(s).`);
  }

  return {
    warehouseId: inputs.warehouseId,
    metricJsonPath: inputs.metricJsonPath,
    outputDir: inputs.outputDir,
    metricTypesPath,
    metricMetadataPath,
  };
}

/**
 * Map a {@link MetricSyncErrorCode} to the canonical exit code. Test consumers
 * import this directly to assert exit-code expectations without spawning a
 * subprocess.
 */
export function exitCodeFor(code: MetricSyncErrorCode): number {
  return EXIT_CODE_BY_CATEGORY[code];
}

export const metricSyncCommand = new Command("sync")
  .description(
    "Sync metric-view schemas from Databricks: fetch DESCRIBE TABLE EXTENDED for every entry in metric.json, then emit metric.d.ts + metrics.metadata.json.",
  )
  .option(
    "--warehouse-id <id>",
    "Databricks SQL Warehouse ID (overrides DATABRICKS_WAREHOUSE_ID env var)",
  )
  .option(
    "--metric-json-path <path>",
    "Path to metric.json (default: config/queries/metric.json)",
  )
  .option(
    "--output-dir <dir>",
    "Output directory for metric.d.ts and metrics.metadata.json (default: shared/appkit-types)",
  )
  .option(
    "--root-dir <dir>",
    "Project root used to resolve relative defaults (default: cwd)",
  )
  .option(
    "-s, --silent",
    "Suppress non-error output and never enter interactive mode",
  )
  .option("--json", "Emit a single-line JSON summary on success")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit metric sync
  $ appkit metric sync --warehouse-id 1234abcd5678efgh
  $ appkit metric sync --metric-json-path config/queries/metric.json
  $ appkit metric sync --output-dir shared/appkit-types --silent

Environment variables:
  DATABRICKS_WAREHOUSE_ID    SQL warehouse ID (used when --warehouse-id is omitted)
  DATABRICKS_HOST            Databricks workspace URL (consumed by the SDK)`,
  )
  .action((opts: MetricSyncFlags) => {
    runMetricSync(opts, {
      log: (msg) => {
        if (opts.json) return;
        console.log(msg);
      },
      error: (msg) => console.error(msg),
    })
      .then((ctx) => {
        if (opts.json) {
          console.log(
            JSON.stringify({
              ok: true,
              warehouseId: ctx.warehouseId,
              metricJsonPath: ctx.metricJsonPath,
              outputDir: ctx.outputDir,
              metricTypesPath: ctx.metricTypesPath,
              metricMetadataPath: ctx.metricMetadataPath,
            }),
          );
        }
        process.exit(0);
      })
      .catch((err: unknown) => {
        if (err instanceof MetricSyncError) {
          if (opts.json) {
            console.log(
              JSON.stringify({
                ok: false,
                code: err.code,
                message: err.message,
                ...(err.fqn ? { fqn: err.fqn } : {}),
              }),
            );
          } else {
            console.error(`Error: ${err.message}`);
          }
          process.exit(exitCodeFor(err.code));
        }

        // Unexpected — preserve the raw error and exit 5.
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(
            JSON.stringify({ ok: false, code: "unknown", message: msg }),
          );
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(exitCodeFor("unknown"));
      });
  });
