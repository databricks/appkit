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
   * DEV-only: get the warehouse to RUNNING in the background and regenerate with
   * real (non-degraded) types once it is — without blocking dev startup. The
   * foreground build only ever degrades in dev (instant `unknown`/cached types),
   * so this is what lands actual DESCRIBE results in the editor for EVERY
   * reachable warehouse state, not just one that happens to already be warm.
   *
   * Post-probe behaviour by state:
   *  - RUNNING → describe right away (the dev foreground degraded, so a running
   *    warehouse would otherwise never get real types — this is the case Phase 3
   *    restores). `waitUntilRunning` returns immediately for an already-running
   *    warehouse, then the blocking regenerate fires.
   *  - STARTING → it's already coming up; just wait for RUNNING, then describe.
   *  - STOPPED / STOPPING → kick off a start, wait for RUNNING, then describe.
   *  - DELETED / DELETING → return (a deleted warehouse can't be started, and
   *    blocking typegen would treat it as fatal); leave the degraded types.
   *
   * No-op in production or without a warehouse id. Replaces any previously-armed
   * watch (aborting it first). Fully self-contained: it never throws into the
   * caller and never re-arms itself. The whole lifecycle is abortable via the
   * shared {@link watchController} — its signal is threaded into
   * `waitUntilRunning`, so a dev-server shutdown cancels a pending wait — and the
   * regenerate routes through {@link runGenerate} so it can't race-write the
   * .d.ts with the foreground degrade or a `.sql` re-trigger.
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

        // A deleted/deleting warehouse can't be started and blocking typegen
        // would treat it as fatal — leave the degraded types and stop. Every
        // other state (including RUNNING) proceeds to wait-then-describe so the
        // dev editor gets real types, not just the foreground's degraded ones.
        if (state === "DELETED" || state === "DELETING") {
          return;
        }

        // Stopped/stopping won't reach RUNNING on its own — nudge it. RUNNING and
        // STARTING need no start (RUNNING is already up; STARTING is coming up),
        // so don't issue a redundant one. A failed start is non-fatal: give up
        // silently rather than throw out of the detached task (the developer
        // still has degraded/cached types).
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

        // Wait for RUNNING. For an already-RUNNING warehouse this returns on the
        // first poll; for STARTING/STOPPED it polls (abortably) until the
        // warehouse warms up, a terminal state, or the deadline.
        const final = await waitUntilRunning(client, warehouseId, {
          maxMs: DEV_WAREHOUSE_WATCH_MAX_MS,
          signal,
          // We just issued the start, so the first poll(s) often still report
          // STOPPED/STOPPING before the start propagates. Poll through those
          // instead of bailing, or the regenerate would never fire. When we
          // didn't start it (RUNNING/STARTING branch), keep the default terminal
          // states.
          treatStoppedAsTransient: startedByUs,
        });

        if (final === "RUNNING" && !signal.aborted) {
          logger.debug("Warehouse is RUNNING; regenerating types.");
          // Blocking: the warehouse is RUNNING now, so describe it and emit real
          // (non-degraded) types — unlike the foreground dev run, which degraded.
          // Routed through the single-flight guard so it coalesces with the
          // foreground degrade / any `.sql` re-trigger instead of racing them.
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
      // (cached/`unknown`) types instantly. Then arm the warehouse watch so the
      // warehouse gets a one-shot BLOCKING regenerate (real types) in the
      // background for EVERY reachable state: RUNNING describes right away, while
      // STARTING/STOPPED are waited (and started) until they reach RUNNING.
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
          // warehouse watch so the edited query is re-described in the background
          // against the running warehouse (or once a still-starting one warms
          // up), landing fresh blocking-described types.
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
