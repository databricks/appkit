import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
   * Internal: present only on the detached worker invocation. Carries the
   * ownership token of the single-flight lock this worker must release when it
   * finishes (the lock PATH is derived from `rootDir`, so it isn't forwarded
   * separately). Its presence is what marks an invocation as "the worker" —
   * workers always run with `--wait`, so they never spawn another worker (only
   * non-blocking runs spawn), which terminates the recursion.
   */
  workerToken?: string;
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
 * that launched us) with `generate-types --wait --worker-token <token>` plus the
 * same positional target options the foreground used, so the worker writes to
 * the same out file / reads the same query folder (and re-derives the lock path
 * from rootDir). The worker is:
 *  - `detached: true` + `.unref()` so it outlives this process (install/dev-setup
 *    can finish and exit while the worker keeps warming the warehouse).
 *  - `stdio: "ignore"` so it never holds the parent's pipes open or interleaves
 *    output into the install/dev log.
 *
 * Spawning is wrapped so any failure is non-fatal: the caller still has degraded
 * types and exits 0.
 *
 * @param token - the ownership token the foreground wrote into the lock; handed
 *   to the worker (via `--worker-token`) so it releases only the lock it owns.
 *   The lock PATH is NOT forwarded — the worker re-derives it from the `rootDir`
 *   positional (deterministic via getSpawnLockPath), so the token is the single
 *   release credential.
 * @param targets - the foreground's positional args, forwarded verbatim.
 * @returns true if the worker was spawned, false if spawning threw.
 */
export function spawnTypegenWorker(
  token: string,
  targets: { rootDir?: string; outFile?: string; warehouseId?: string },
): boolean {
  // The script the runtime launched us with (the `appkit` bin shim). Re-running
  // it under the same node binary reproduces this exact CLI in the worker.
  const cliEntry = process.argv[1];

  // Forward the positionals in declaration order (rootDir, outFile,
  // warehouseId). Stop at the first undefined so we never pass a literal
  // "undefined" — commander would treat it as a positional value. (rootDir is
  // effectively always set by commander's default, and the worker needs it to
  // re-derive the lock path, but guard anyway.)
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
    "--worker-token",
    token,
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
 *  3. If this IS the worker (`--worker-token` present), it ran blocking above and
 *     releases the lock here — by re-deriving the lock path from rootDir and
 *     unlinking only if the lock still carries its token (and via a process-exit
 *     guard, so a hard failure / process.exit still frees it).
 */
async function generateTypesAction(
  rootDir: string | undefined,
  outFile: string | undefined,
  warehouseId: string | undefined,
  options: GenerateTypesOptions,
) {
  const workerToken = options.workerToken;
  const isWorker = typeof workerToken === "string";

  // A worker releases the lock by its derived PATH + the ownership TOKEN it was
  // handed: the unlink only happens if the on-disk lock still carries that token,
  // so a worker whose lock was stolen as stale can't delete the new owner's lock.
  // The path is re-derived from the same rootDir the foreground used.
  const workerLockPath = isWorker
    ? getSpawnLockPath(rootDir || process.cwd())
    : undefined;

  // A worker must always free its lock, even if the blocking generate throws or
  // calls process.exit (TypegenFatalError → exit 1). The exit handler covers the
  // process.exit / uncaught paths; the finally covers the normal return.
  if (isWorker && workerLockPath && workerToken) {
    process.once("exit", () => releaseSpawnLock(workerLockPath, workerToken));
  }

  try {
    await runGenerateTypes(rootDir, outFile, warehouseId, options);
  } finally {
    if (isWorker && workerLockPath && workerToken) {
      releaseSpawnLock(workerLockPath, workerToken);
    }
  }

  // Only a non-blocking, non-worker invocation spawns. A worker is always
  // --wait (so resolveTypegenMode → "blocking"), which both prevents recursion
  // and means we never get here for a worker.
  if (!isWorker && resolveTypegenMode(options) === "non-blocking") {
    const resolvedRootDir = rootDir || process.cwd();
    const lockPath = getSpawnLockPath(resolvedRootDir);
    // A fresh per-acquisition credential: written into the lock body and handed
    // to the worker so only it can release this lock.
    const token = randomUUID();

    if (acquireSpawnLock(lockPath, token)) {
      spawnTypegenWorker(token, { rootDir, outFile, warehouseId });
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
  // Internal: marks the detached background worker and carries the ownership
  // token it must present to release the lock. Hidden from --help; users should
  // never pass it.
  .addOption(
    new Option(
      "--worker-token <token>",
      "Internal: detached worker lock ownership token",
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
