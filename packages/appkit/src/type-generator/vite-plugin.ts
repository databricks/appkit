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
  let inFlight: Promise<void> | null = null;
  let queued = false;

  // The currently-armed DEV background warehouse watch, if any. Aborting it
  // stops a pending waitUntilRunning (server shutdown, or a newer arm replacing
  // an older one).
  let watchController: AbortController | null = null;

  /**
   * Generate types once. Never throws in dev (logs instead); in production it
   * rethrows so the build fails. This is the un-guarded core — callers should
   * go through {@link runGenerate} so concurrent triggers can't race-write the
   * .d.ts.
   */
  async function generateOnce() {
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
        // Production build blocks for warehouse readiness and fails fast on a
        // stopped/deleted warehouse; dev rolls forward (degrades) and never
        // blocks startup.
        mode: process.env.NODE_ENV === "production" ? "blocking" : "dev",
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
   * If a run is already in flight, this does NOT start a second one — it sets a
   * trailing flag so exactly one more run fires after the current finishes,
   * coalescing any number of overlapping triggers (latest-wins).
   *
   * @returns A promise that resolves when this trigger's work (including any
   *   trailing run it scheduled) has completed.
   */
  function runGenerate(): Promise<void> {
    if (inFlight) {
      // A run is active: remember that another trigger arrived and ride out the
      // current run. One trailing run then covers all coalesced triggers.
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
        await generateOnce();
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
          await runGenerate();
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
        return runGenerate();
      }

      // Dev: don't block startup waiting on typegen. Kick off the initial
      // generate, then arm the warehouse watch so a cold-starting warehouse gets
      // a one-shot regenerate once it's RUNNING.
      void runGenerate();
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
          // generate(), which could race the initial build / watch). Re-arm the
          // warehouse watch too: editing a query against a still-starting
          // warehouse should also pick up fresh types once it warms up.
          void runGenerate();
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
