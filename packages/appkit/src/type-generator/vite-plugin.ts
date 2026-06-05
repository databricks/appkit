import { existsSync } from "node:fs";
import path from "node:path";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import type { Plugin } from "vite";
import { createLogger } from "../logging/logger";
import {
  ANALYTICS_TYPES_FILE,
  generateFromEntryPoint,
  TYPES_DIR,
  TypegenFatalError,
  TypegenSyntaxError,
} from "./index";
import type { PreflightMode } from "./preflight";
import {
  getWarehouseState,
  startWarehouse,
  waitUntilRunning,
} from "./warehouse-status";

const logger = createLogger("type-generator:vite-plugin");

/**
 * How long the DEV background watcher waits for a STARTING warehouse to reach
 * RUNNING before giving up. Short relative to the CLI's preflight budget: this
 * is a best-effort "regenerate once the warehouse warms up" convenience, not a
 * gate, so we'd rather stop polling than hold a detached task open for minutes.
 */
const DEV_WAREHOUSE_WATCH_MAX_MS = 60_000;

/**
 * Options for the AppKit types plugin.
 */
interface AppKitTypesPluginOptions {
  /* Path to the output d.ts file (relative to client folder). */
  outFile?: string;
  /** Folders to watch for changes. */
  watchFolders?: string[];
}

/**
 * Vite plugin to generate types for AppKit queries.
 * Calls generateFromEntryPoint under the hood.
 * @param options - Options to override default values.
 * @returns Vite plugin to generate types for AppKit queries.
 */
export function appKitTypesPlugin(options?: AppKitTypesPluginOptions): Plugin {
  let outFile: string;
  let watchFolders: string[];

  // Single-flight state for runGenerate(). `inFlight` is the promise of the
  // currently-running drain (null when idle); `queued` records that a trigger
  // arrived while a run was active so exactly ONE trailing run fires afterwards
  // (latest-wins — coalesces any number of overlapping triggers into a single
  // rerun). `queued` is read/cleared synchronously inside the drain loop so a
  // trigger landing in any window is caught before the drain exits.
  //
  // `pendingMode` is the mode the next generate should run in (latest-wins, like
  // `queued`): the foreground build runs non-blocking in dev (instant degrade)
  // while the background warehouse watch runs blocking (real DESCRIBEs). A
  // blocking watch trigger that lands while a non-blocking foreground run is in
  // flight therefore still describes when its trailing run fires.
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let pendingMode: PreflightMode = "non-blocking";

  // The currently-armed DEV background warehouse watch, if any. Aborting it
  // stops a pending waitUntilRunning (server shutdown, or a newer arm replacing
  // an older one).
  let watchController: AbortController | null = null;

  /**
   * Generate types once in the given preflight {@link PreflightMode}. Never
   * throws in dev (logs instead); in production it rethrows so the build fails.
   * This is the un-guarded core — callers should go through {@link runGenerate}
   * so concurrent triggers can't race-write the .d.ts.
   *
   * @param mode - preflight policy for this run. The foreground build passes a
   *   NODE_ENV-derived mode (blocking in production, non-blocking in dev so it
   *   degrades instantly); the background warehouse watch passes "blocking" so
   *   its regenerate actually DESCRIBEs and lands real (non-degraded) types.
   */
  async function generateOnce(mode: PreflightMode) {
    try {
      const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID || "";

      if (!warehouseId) {
        logger.debug("Warehouse ID not found. Skipping type generation.");
        return;
      }

      await generateFromEntryPoint({
        outFile,
        queryFolder: watchFolders[0],
        warehouseId,
        noCache: false,
        mode,
      });
    } catch (error) {
      // TypegenSyntaxError / TypegenFatalError carry a complete, actionable
      // report in their message. Their stack frames and attached query arrays
      // point into appkit internals and only add noise, so surface just the
      // message — both when failing the prod build and when logging in dev.
      const isTypegenError =
        error instanceof TypegenSyntaxError ||
        error instanceof TypegenFatalError;

      // throw in production to fail the build
      if (process.env.NODE_ENV === "production") {
        if (isTypegenError) error.stack = error.message;
        throw error;
      }

      if (isTypegenError) {
        logger.error("%s", error.message);
      } else {
        logger.error("Error generating types: %O", error);
      }
    }
  }

  /**
   * Single-flight wrapper around {@link generateOnce}. The initial build, the
   * .sql watcher, and the DEV warehouse watch all route through here so they can
   * never run typegen concurrently (which would race-write the .d.ts).
   *
   * If a run is already in flight, this does NOT start a second one — it records
   * the requested mode and sets a trailing flag so exactly one more run fires
   * after the current finishes, coalescing any number of overlapping triggers
   * (latest-wins, including the mode: a blocking watch trigger that arrives mid
   * non-blocking foreground run still describes when its trailing run fires).
   *
   * @param mode - preflight policy for this run. Recorded into `pendingMode`,
   *   which the drain reads for each generate (latest trigger wins).
   * @returns A promise that resolves when this trigger's work (including any
   *   trailing run it scheduled) has completed.
   */
  function runGenerate(mode: PreflightMode): Promise<void> {
    pendingMode = mode;

    if (inFlight) {
      // A run is active: remember that another trigger arrived and ride out the
      // current run. One trailing run then covers all coalesced triggers and
      // runs in the latest requested mode (recorded above).
      queued = true;
      return inFlight;
    }

    // Drain in a loop rather than recursing after a single queued-check: a
    // trigger can land in the window between generateOnce() resolving and the
    // check, so we re-test `queued` until it's clear. Critically, `inFlight` is
    // cleared synchronously in the SAME tick as the final `queued === false`
    // observation — never deferred to a .finally microtask — so there's no
    // window where a trigger sees `inFlight` set but the drain has already
    // decided to exit. The guard stays held for the whole drain, so concurrent
    // triggers only ever set the flag; they never start a parallel generate.
    const drain = async (): Promise<void> => {
      while (true) {
        queued = false;
        // Snapshot the mode synchronously alongside clearing `queued` so a
        // trigger landing during this generate is observed (via `queued`) on the
        // next loop with its own mode, not silently dropped.
        const runMode = pendingMode;
        await generateOnce(runMode);
        // Synchronous check + clear, atomic w.r.t. other (synchronous) callers.
        if (!queued) {
          inFlight = null;
          return;
        }
      }
    };

    inFlight = drain();
    return inFlight;
  }

  /**
   * DEV-only: warm a stopped/cold-starting warehouse in the background and
   * regenerate once it reaches RUNNING, so fresh (non-degraded) types land in
   * the editor — without blocking dev startup.
   *
   * Post-probe behaviour by state:
   *  - RUNNING → return (the initial build already produced fresh types).
   *  - DELETED / DELETING → return (a deleted warehouse can't be started).
   *  - STOPPED / STOPPING → kick off a start, then wait for RUNNING.
   *  - STARTING → it's already coming up; just wait for RUNNING.
   *
   * No-op in production or without a warehouse id. Replaces any previously-armed
   * watch (aborting it first). Fully self-contained: it never throws into the
   * caller and never re-arms itself.
   *
   * The regenerate runs in "blocking" mode (not the foreground's non-blocking)
   * so it actually DESCRIBEs the now-RUNNING warehouse and lands real types —
   * the whole point of warming the warehouse in the background.
   */
  function armWarehouseWatch(): void {
    if (process.env.NODE_ENV === "production") return;

    const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID || "";
    if (!warehouseId) return;

    // Supersede any in-flight watch so we never run two concurrently.
    watchController?.abort();
    const controller = new AbortController();
    watchController = controller;
    const { signal } = controller;

    void (async () => {
      try {
        const client = new WorkspaceClient({});
        const state = await getWarehouseState(client, warehouseId);

        // RUNNING already produced fresh types on the initial build; a deleted
        // warehouse can't be started. Neither is worth watching.
        if (
          state === "RUNNING" ||
          state === "DELETED" ||
          state === "DELETING"
        ) {
          return;
        }

        // Stopped/stopping won't reach RUNNING on its own — nudge it. STARTING
        // is already coming up, so don't issue a redundant start. A failed start
        // is non-fatal: give up silently rather than throw out of the detached
        // task (the developer still has degraded/cached types).
        let startedByUs = false;
        if (state === "STOPPED" || state === "STOPPING") {
          try {
            logger.debug("Warehouse is %s; starting it.", state);
            await startWarehouse(client, warehouseId);
            startedByUs = true;
          } catch {
            return;
          }
        }

        const final = await waitUntilRunning(client, warehouseId, {
          maxMs: DEV_WAREHOUSE_WATCH_MAX_MS,
          signal,
          // We just issued the start, so the first poll(s) often still report
          // STOPPED/STOPPING before the start propagates. Poll through those
          // instead of bailing, or the regenerate would never fire. When we
          // didn't start it (STARTING branch), keep the default terminal states.
          treatStoppedAsTransient: startedByUs,
        });

        if (final === "RUNNING" && !signal.aborted) {
          logger.debug("Warehouse reached RUNNING; regenerating types.");
          // Blocking: the warehouse is RUNNING now, so describe it and emit real
          // (non-degraded) types — unlike the foreground dev run, which degraded.
          await runGenerate("blocking");
        }
      } catch {
        // Detached background task: any failure (timeout, abort, connectivity,
        // auth) is non-fatal — the developer still has degraded/cached types.
      }
    })();
  }

  return {
    name: "appkit-types",

    apply() {
      const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID || "";

      if (!warehouseId) {
        logger.debug("Warehouse ID not found. Skipping type generation.");
        return false;
      }

      if (!existsSync(path.join(process.cwd(), "config", "queries"))) {
        return false;
      }

      return true;
    },

    configResolved(config) {
      const projectRoot = path.resolve(config.root, "..");
      outFile = path.resolve(
        projectRoot,
        options?.outFile ?? `shared/${TYPES_DIR}/${ANALYTICS_TYPES_FILE}`,
      );
      watchFolders = options?.watchFolders ?? [
        path.join(process.cwd(), "config", "queries"),
      ];
    },

    buildStart() {
      // Production: block the build on this generate (and surface failures).
      // The watch is a dev-only no-op, so just run typegen.
      if (process.env.NODE_ENV === "production") {
        return runGenerate("blocking");
      }

      // Dev: don't block startup waiting on typegen. The foreground generate runs
      // non-blocking — it skips the warehouse entirely and writes degraded
      // (cached/`unknown`) types instantly. Then arm the warehouse watch so a
      // cold-starting warehouse gets a one-shot BLOCKING regenerate (real types)
      // once it's RUNNING.
      void runGenerate("non-blocking");
      armWarehouseWatch();
    },

    configureServer(server) {
      server.watcher.add(watchFolders);

      server.watcher.on("change", (changedFile) => {
        const isWatchedFile = watchFolders.some((folder) =>
          changedFile.startsWith(folder),
        );

        if (isWatchedFile && changedFile.endsWith(".sql")) {
          // Route through the single-flight runner (was fire-and-forget
          // generate(), which could race the initial build / watch). This is a
          // dev-only hook, so degrade instantly (non-blocking), then re-arm the
          // warehouse watch: editing a query against a still-starting warehouse
          // should pick up fresh (blocking-described) types once it warms up.
          void runGenerate("non-blocking");
          armWarehouseWatch();
        }
      });

      // Tear down any pending warehouse watch when the dev server closes so a
      // long backoff can't keep the process alive after shutdown.
      server.httpServer?.once("close", () => {
        watchController?.abort();
      });
    },
  };
}
