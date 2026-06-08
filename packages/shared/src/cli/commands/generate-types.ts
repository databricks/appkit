import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import {
  acquireSpawnLock,
  getSpawnLockPath,
  releaseSpawnLock,
} from "./spawn-lock.js";

/**
 * Resolve the typegen pre-flight mode for the CLI. Defaults to "non-blocking" —
 * a one-shot CLI can't describe in the background, so by default it never
 * describes at all: it skips the warehouse probe AND every DESCRIBE, emits
 * best-available types (cache where the SQL hash matches, else `result: unknown`)
 * and returns immediately, never blocking on — or failing because of — a
 * warehouse, even a RUNNING one. Pass `--wait` (commander sets `wait: true`)
 * for a deliberate/CI invocation that should wait for a starting warehouse and
 * fail fast on a stopped one.
 */
export function resolveTypegenMode(options?: {
  wait?: boolean;
}): "non-blocking" | "blocking" {
  return options?.wait ? "blocking" : "non-blocking";
}

/** Options parsed by commander for the generate-types command. */
interface GenerateTypesOptions {
  noCache?: boolean;
  wait?: boolean;
  /**
   * Internal: present only on the detached worker invocation. Carries the path
   * of the single-flight lock this worker must release when it finishes. Its
   * presence is what marks an invocation as "the worker" — workers always run
   * with `--wait`, so they never spawn another worker (only non-blocking runs
   * spawn), which terminates the recursion.
   */
  workerLock?: string;
}

/**
 * Generate types command implementation. Runs the library generate (which, in
 * non-blocking mode, writes degraded types and returns immediately). This is the
 * SAME work the worker performs in blocking mode in the background.
 */
async function runGenerateTypes(
  rootDir?: string,
  outFile?: string,
  warehouseId?: string,
  options?: GenerateTypesOptions,
) {
  try {
    const resolvedRootDir = rootDir || process.cwd();
    const noCache = options?.noCache || false;
    const mode = resolveTypegenMode(options);

    const typeGen = await import("@databricks/appkit/type-generator");

    // Generate analytics query types (requires warehouse ID)
    const resolvedWarehouseId =
      warehouseId || process.env.DATABRICKS_WAREHOUSE_ID;

    if (resolvedWarehouseId) {
      const resolvedOutFile =
        outFile ||
        path.join(process.cwd(), "shared/appkit-types/analytics.d.ts");

      const queryFolder = path.join(resolvedRootDir, "config/queries");
      if (fs.existsSync(queryFolder)) {
        await typeGen.generateFromEntryPoint({
          queryFolder,
          outFile: resolvedOutFile,
          warehouseId: resolvedWarehouseId,
          noCache,
          mode,
        });
        console.log(`Generated query types: ${resolvedOutFile}`);
      }
    } else {
      console.error(
        "Skipping query type generation: no warehouse ID. Set DATABRICKS_WAREHOUSE_ID or pass as argument.",
      );
    }

    // Generate serving endpoint types (no warehouse required)
    const servingOutFile = path.join(
      process.cwd(),
      "shared/appkit-types/serving.d.ts",
    );
    await typeGen.generateServingTypes({
      outFile: servingOutFile,
      noCache,
    });
    console.log(`Generated serving types: ${servingOutFile}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Cannot find module")
    ) {
      console.error(
        "Error: The 'generate-types' command is only available in @databricks/appkit.",
      );
      console.error("Please install @databricks/appkit to use this command.");
      process.exit(1);
    }
    // TypegenSyntaxError / TypegenFatalError carry a complete, actionable
    // message (which queries failed and how to debug them). The stack trace
    // points into appkit internals and is noise for app developers, so print
    // only the message and exit non-zero instead of letting it bubble up.
    if (
      error instanceof Error &&
      (error.name === "TypegenSyntaxError" ||
        error.name === "TypegenFatalError")
    ) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Spawn the detached blocking worker that refreshes real types in the background
 * after the foreground non-blocking generate has already written degraded types.
 *
 * Re-invokes THIS CLI (`process.execPath` + `process.argv[1]` — the bin entry
 * that launched us) with `generate-types --wait --worker-lock <lockPath>` plus
 * the same positional target options the foreground used, so the worker writes
 * to the same out file / reads the same query folder. The worker is:
 *  - `detached: true` + `.unref()` so it outlives this process (install/dev-setup
 *    can finish and exit while the worker keeps warming the warehouse).
 *  - `stdio: "ignore"` so it never holds the parent's pipes open or interleaves
 *    output into the install/dev log.
 *
 * Spawning is wrapped so any failure is non-fatal: the caller still has degraded
 * types and exits 0.
 *
 * @param lockPath - the acquired single-flight lock; passed to the worker so it
 *   releases the SAME lock when it finishes.
 * @param targets - the foreground's positional args, forwarded verbatim.
 * @returns true if the worker was spawned, false if spawning threw.
 */
export function spawnTypegenWorker(
  lockPath: string,
  targets: { rootDir?: string; outFile?: string; warehouseId?: string },
): boolean {
  // The script the runtime launched us with (the `appkit` bin shim). Re-running
  // it under the same node binary reproduces this exact CLI in the worker.
  const cliEntry = process.argv[1];

  // Forward the positionals in declaration order (rootDir, outFile,
  // warehouseId). Stop at the first undefined so we never pass a literal
  // "undefined" — commander would treat it as a positional value. (rootDir is
  // effectively always set by commander's default, but guard anyway.)
  const positionals: string[] = [];
  for (const value of [targets.rootDir, targets.outFile, targets.warehouseId]) {
    if (value === undefined) break;
    positionals.push(value);
  }

  const args = [
    // Forward the parent's node/loader flags so the worker runs under the same
    // runtime. Critically this carries tsx's `--require`/`--import` when the CLI
    // is run from source (`tsx index.ts …`); without them the worker would be
    // `node index.ts …`, which can't parse TypeScript and dies silently — the
    // degraded types would then never refresh. Empty for the built bin (plain
    // `node bin/appkit.js`), so production behaviour is unchanged.
    ...process.execArgv,
    cliEntry,
    "generate-types",
    "--wait",
    "--worker-lock",
    lockPath,
    ...positionals,
  ];

  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch (error) {
    // Non-fatal: the foreground already wrote degraded types. Log and move on.
    console.error(
      `Could not start background type refresh: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * The command action. Orchestrates the non-blocking foreground contract:
 *  1. Run the library generate (writes degraded types immediately in non-blocking
 *     mode; does the full blocking lifecycle when this is the worker).
 *  2. If this is a non-blocking, non-worker invocation, try to spawn the detached
 *     blocking worker behind the single-flight lock. If the lock is already held
 *     by a live worker, skip (single-flight) with a one-line note. Either way the
 *     foreground returns normally (exit 0).
 *  3. If this IS the worker (`--worker-lock` present), it ran blocking above and
 *     releases the lock here (and via a process-exit guard, so a hard failure /
 *     process.exit still frees it).
 */
async function generateTypesAction(
  rootDir: string | undefined,
  outFile: string | undefined,
  warehouseId: string | undefined,
  options: GenerateTypesOptions,
) {
  const isWorker = typeof options.workerLock === "string";

  // A worker must always free its lock, even if the blocking generate throws or
  // calls process.exit (TypegenFatalError → exit 1). The exit handler covers the
  // process.exit / uncaught paths; the finally covers the normal return.
  if (isWorker && options.workerLock) {
    const lockPath = options.workerLock;
    process.once("exit", () => releaseSpawnLock(lockPath));
  }

  try {
    await runGenerateTypes(rootDir, outFile, warehouseId, options);
  } finally {
    if (isWorker && options.workerLock) {
      releaseSpawnLock(options.workerLock);
    }
  }

  // Only a non-blocking, non-worker invocation spawns. A worker is always
  // --wait (so resolveTypegenMode → "blocking"), which both prevents recursion
  // and means we never get here for a worker.
  if (!isWorker && resolveTypegenMode(options) === "non-blocking") {
    const resolvedRootDir = rootDir || process.cwd();
    const lockPath = getSpawnLockPath(resolvedRootDir);

    if (acquireSpawnLock(lockPath)) {
      spawnTypegenWorker(lockPath, { rootDir, outFile, warehouseId });
    } else {
      console.log("Type refresh already in progress, skipping.");
    }
  }
}

export const generateTypesCommand = new Command("generate-types")
  .description("Generate TypeScript types from SQL queries")
  .argument("[rootDir]", "Root directory of the project", process.cwd())
  .argument(
    "[outFile]",
    "Output file path",
    path.join(process.cwd(), "shared/appkit-types/analytics.d.ts"),
  )
  .argument("[warehouseId]", "Databricks warehouse ID")
  .option("--no-cache", "Disable caching for type generation")
  .option(
    "--wait",
    "Wait for warehouse readiness instead of degrading (use for CI)",
  )
  // Internal: marks the detached background worker and carries the lock it must
  // release. Hidden from --help; users should never pass it.
  .addOption(
    new Option(
      "--worker-lock <path>",
      "Internal: detached worker lock path",
    ).hideHelp(),
  )
  .addHelpText(
    "after",
    `
Examples:
  $ appkit generate-types
  $ appkit generate-types . shared/appkit-types/analytics.d.ts
  $ appkit generate-types . shared/appkit-types/analytics.d.ts my-warehouse-id
  $ appkit generate-types --no-cache
  $ appkit generate-types --wait   # CI: wait for the warehouse and fail on a cold one`,
  )
  .action(generateTypesAction);
