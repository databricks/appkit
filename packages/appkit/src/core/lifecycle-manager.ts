import type { BasePlugin } from "shared";

import { CacheManager } from "../cache";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";
import type { PluginContext } from "./plugin-context";

const logger = createLogger("lifecycle");

/**
 * Owns the process's graceful-shutdown sequence.
 *
 * Created by AppKit core once every plugin has started. It is the single
 * owner of the SIGTERM/SIGINT handlers and of `process.exit`, mirroring the
 * core-owned startup in `AppKit._createApp`: core initializes telemetry,
 * cache, and the internal-telemetry reporter, and core tears them all down
 * here. Plugins participate through the generic hooks
 * (`abortActiveOperations()`, `shutdown()`, and `onLifecycle("shutdown")`) —
 * they do not touch process signals or the core singletons themselves.
 */
export class LifecycleManager {
  /**
   * Overall graceful-shutdown budget before the process is force-exited.
   *
   * Budget arithmetic: plugin `shutdown()` hooks run concurrently and are
   * bounded by {@link PLUGIN_SHUTDOWN_TIMEOUT_MS} (10s); the lifecycle emit
   * is bounded by {@link PHASE_SHUTDOWN_TIMEOUT_MS} (2s); the cache storage
   * close and the telemetry flush run concurrently, each bounded by
   * {@link PHASE_SHUTDOWN_TIMEOUT_MS} (2s). Worst case is
   * 10s + 2s + max(2s, 2s) = 14s, leaving ~1s of margin for the remaining
   * steps (aborts) before this timer force-exits.
   */
  private static readonly SHUTDOWN_TIMEOUT_MS = 15_000;
  /**
   * Per-plugin budget for `shutdown()` hooks. Sized to cover the longest
   * built-in drain (the files plugin waits up to 10s for in-flight writes).
   */
  private static readonly PLUGIN_SHUTDOWN_TIMEOUT_MS = 10_000;
  /**
   * Budget for each non-plugin shutdown phase (the `"shutdown"` lifecycle
   * emit, the cache storage close, and the telemetry flush). Keeps the
   * worst-case total under {@link SHUTDOWN_TIMEOUT_MS} — see the arithmetic
   * there.
   */
  private static readonly PHASE_SHUTDOWN_TIMEOUT_MS = 2_000;

  /**
   * Guards against re-entrant shutdown (e.g. SIGTERM followed by SIGINT).
   * The flag set in `shutdown` must remain synchronous and first — any
   * `await` before it would open a window for a second signal to re-enter
   * the sequence.
   */
  private isShuttingDown = false;
  /**
   * Name of the shutdown phase currently in flight, so the force-exit log
   * can say where shutdown got stuck without extra bookkeeping.
   */
  private shutdownPhase = "not started";

  constructor(private readonly context: PluginContext) {}

  /**
   * Install the SIGTERM/SIGINT handlers that trigger {@link shutdown}.
   *
   * Uses `process.once` (not `on`) so a repeated signal cannot register the
   * handler twice; re-entrancy from a *different* signal is guarded by
   * `isShuttingDown` inside {@link shutdown}.
   */
  installSignalHandlers(): void {
    process.once("SIGTERM", () => this.shutdown());
    process.once("SIGINT", () => this.shutdown());
  }

  /**
   * Run the graceful-shutdown sequence and exit the process.
   *
   * Phases:
   * 1. stop the internal-telemetry reporter
   * 2. abort in-flight work on every plugin (cancellation only — teardown of
   *    shared resources belongs in `shutdown()` so peers can still drain)
   * 3. run every plugin's `shutdown()` hook concurrently, each bounded
   * 4. emit the `"shutdown"` lifecycle event, bounded
   * 5. close the cache storage and flush telemetry concurrently, each bounded
   *
   * Exits 0 on completion (and on the force-exit backstop): a deliberate
   * shutdown is not a crash. Exit 1 is reserved for an unexpected error
   * thrown by the sequence itself.
   */
  async shutdown(): Promise<void> {
    // Must stay synchronous and first: any await before the flag is set
    // would let a second signal re-enter the shutdown sequence.
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info("Starting graceful shutdown...");

    let exitCode = 0;

    // Force exit once the overall budget is spent. Exit 0 is deliberate:
    // a force-timeout still happens on a routine deploy (deliberate
    // shutdown, not a crash), and orchestrators record nonzero exits on
    // deploys as crashes. The error log below is the stuck-shutdown
    // signal instead of the exit code.
    const forceExitTimer = setTimeout(() => {
      logger.error(
        "Graceful shutdown did NOT complete within the %dms budget (phase in flight: %s); force-exiting with code 0.",
        LifecycleManager.SHUTDOWN_TIMEOUT_MS,
        this.shutdownPhase,
      );
      process.exit(0);
    }, LifecycleManager.SHUTDOWN_TIMEOUT_MS);
    // unref so this backstop timer never by itself keeps the process alive.
    // Any real pending teardown (OTEL export timer, DB pool sockets, the
    // still-open HTTP listener) is a ref'd handle that holds the loop open
    // until this fires; if nothing is ref'd, there is nothing left to tear
    // down and exiting early is correct.
    forceExitTimer.unref();

    try {
      const plugins = Array.from(this.context.getPlugins().values());

      // 1. stop the internal-telemetry reporter (no-op if never started).
      this.shutdownPhase = "stopping internal telemetry reporter";
      TelemetryReporter.getInstance()?.stop();

      // 2. abort active operations from plugins (in-flight executions, SSE
      //    streams). Cancellation only — resource teardown (e.g. the
      //    lakebase pools, the server's socket close) belongs in plugin
      //    shutdown() hooks / lifecycle subscribers so other plugins can
      //    still drain state through them.
      this.shutdownPhase = "aborting active operations";
      for (const plugin of plugins) {
        if (plugin.abortActiveOperations) {
          try {
            plugin.abortActiveOperations();
          } catch (err) {
            logger.error(
              "Error aborting operations for plugin %s: %O",
              plugin.name,
              err,
            );
          }
        }
      }

      // 3. run every plugin's shutdown() hook concurrently, each bounded
      //    by a per-plugin timeout so one hung plugin cannot stall exit.
      this.shutdownPhase = "plugin shutdown() hooks";
      await Promise.all(
        plugins
          .filter((plugin) => typeof plugin.shutdown === "function")
          .map((plugin) => this.runPluginShutdown(plugin)),
      );

      // 4. notify lifecycle subscribers, bounded so a slow subscriber
      //    cannot eat the remaining budget. The server plugin closes its
      //    remaining sockets here, after other plugins have drained.
      this.shutdownPhase = "shutdown lifecycle emit";
      try {
        await this.raceWithTimeout(
          this.context.emitLifecycle("shutdown"),
          LifecycleManager.PHASE_SHUTDOWN_TIMEOUT_MS,
          "shutdown lifecycle emit",
        );
      } catch (err) {
        logger.error("Error emitting shutdown lifecycle event: %O", err);
      }

      // 5. close the cache manager's storage (drains the persistent
      //    Lakebase pool; no-op for in-memory storage) and flush telemetry.
      //    Runs after the lifecycle emit so subscribers can still read the
      //    cache. The two are independent (the flush never touches the
      //    cache), so they run concurrently — each bounded so a stuck pool
      //    drain or stalled OTLP export cannot eat the remaining budget.
      this.shutdownPhase = "cache storage close + telemetry flush";
      await Promise.all([this.closeCacheStorage(), this.flushTelemetry()]);

      logger.info("Graceful shutdown complete");
    } catch (err) {
      // Exit 1 is reserved for an unexpected error thrown by the sequence
      // itself; every per-phase failure above is already caught and logged.
      logger.error("Error during graceful shutdown: %O", err);
      exitCode = 1;
    }

    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }

  /** Close the cache storage, bounded and error-isolated. */
  private async closeCacheStorage(): Promise<void> {
    let cache: CacheManager;
    try {
      cache = CacheManager.getInstanceSync();
    } catch {
      // Cache was never initialized — nothing to close.
      return;
    }
    try {
      await this.raceWithTimeout(
        cache.close(),
        LifecycleManager.PHASE_SHUTDOWN_TIMEOUT_MS,
        "cache storage close",
      );
    } catch (err) {
      logger.error("Error closing cache storage during shutdown: %O", err);
    }
  }

  /** Flush and shut down the telemetry SDK, bounded and error-isolated. */
  private async flushTelemetry(): Promise<void> {
    try {
      await this.raceWithTimeout(
        TelemetryManager.getInstance().shutdown(),
        LifecycleManager.PHASE_SHUTDOWN_TIMEOUT_MS,
        "telemetry flush",
      );
    } catch (err) {
      logger.error("Error flushing telemetry during shutdown: %O", err);
    }
  }

  /**
   * Run a single plugin's `shutdown()` hook bounded by
   * {@link LifecycleManager.PLUGIN_SHUTDOWN_TIMEOUT_MS}. Errors and timeouts
   * are logged but never thrown so one misbehaving plugin cannot block
   * the rest of the shutdown sequence.
   */
  private async runPluginShutdown(plugin: BasePlugin): Promise<void> {
    try {
      await this.raceWithTimeout(
        plugin.shutdown?.(),
        LifecycleManager.PLUGIN_SHUTDOWN_TIMEOUT_MS,
        "shutdown()",
      );
    } catch (err) {
      logger.error("Error shutting down plugin %s: %O", plugin.name, err);
    }
  }

  /**
   * Race `work` against a timeout. Rejects with a labeled error when the
   * timeout wins. A no-op rejection handler is attached to the work promise
   * before racing so a branch that rejects after the timeout already won
   * does not surface as an unhandledRejection.
   */
  private async raceWithTimeout<T>(
    work: Promise<T> | T,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const promise = Promise.resolve(work);
    promise.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
