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
   * The in-flight teardown, memoized. A boolean guard would let a second caller
   * return while teardown was still running — fine for a signal, wrong for the
   * harness path (`{ exit: false }`), which must not resolve before resources
   * are released.
   */
  private teardown: Promise<number> | undefined;
  /** Reported by the force-exit log so a stuck shutdown names its phase. */
  private shutdownPhase = "not started";

  constructor(private readonly context: PluginContext) {}

  /**
   * Install the SIGTERM/SIGINT handlers that trigger {@link shutdown}. Never
   * removed: the signal path exits the process, and the harness opts out of
   * installing them, so nothing accumulates across boots.
   */
  installSignalHandlers(): void {
    process.once("SIGTERM", () => void this.shutdown());
    process.once("SIGINT", () => void this.shutdown());
  }

  /**
   * Run the graceful-shutdown sequence. Exits the process unless
   * `exit: false` — the flag the test harness passes so it can tear a booted
   * app down between tests without killing the vitest process.
   *
   * Phases:
   * 1. stop the internal-telemetry reporter
   * 2. abort in-flight work on every plugin (cancellation only — teardown of
   *    shared resources belongs in `shutdown()` so peers can still drain)
   * 3. run every plugin's `shutdown()` hook concurrently, each bounded
   * 4. emit the `"shutdown"` lifecycle event, bounded
   * 5. close the cache storage and flush telemetry concurrently, each bounded
   *
   * Every phase is individually bounded, so the sequence always completes —
   * `{ exit: false }` therefore needs no outer timeout and an `afterEach`
   * cannot hang on it. A second call joins the first teardown.
   *
   * Exits 0 on completion (and on the force-exit backstop): a deliberate
   * shutdown is not a crash. Exit 1 is reserved for an unexpected error
   * thrown by the sequence itself.
   */
  async shutdown(options: { exit?: boolean } = {}): Promise<void> {
    const exit = options.exit ?? true;

    if (!exit) {
      // Harness path: no backstop, no process.exit. The phases are internally
      // bounded, and this is fully awaited before the harness drops the
      // singletons — so phase 5 always acts on this app's own cache/telemetry.
      await this.runPhasesOnce();
      return;
    }

    // Exit 0 on force-timeout: a stuck deploy shutdown is not a crash, and
    // orchestrators read nonzero deploy exits as one. The error log is the
    // signal instead. Belt-and-suspenders over the per-phase budgets.
    const forceExitTimer = setTimeout(() => {
      logger.error(
        "Graceful shutdown did NOT complete within the %dms budget (phase in flight: %s); force-exiting with code 0.",
        LifecycleManager.SHUTDOWN_TIMEOUT_MS,
        this.shutdownPhase,
      );
      process.exit(0);
    }, LifecycleManager.SHUTDOWN_TIMEOUT_MS);
    // unref'd so the backstop alone never holds the process open; real pending
    // teardown is ref'd and keeps the loop alive until this fires.
    forceExitTimer.unref();

    const exitCode = await this.runPhasesOnce();

    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }

  /** No `await` between read and assign — that gap is the re-entrancy window. */
  private runPhasesOnce(): Promise<number> {
    this.teardown ??= this.runPhases();
    return this.teardown;
  }

  /** Run the phases and report an exit code; no process-termination concerns. */
  private async runPhases(): Promise<number> {
    logger.info("Starting graceful shutdown...");

    let exitCode = 0;

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

    return exitCode;
  }

  /** Bounded and error-isolated. Reads the cache manager at phase-5 time. */
  private async closeCacheStorage(): Promise<void> {
    let cache: CacheManager | undefined;
    try {
      cache = CacheManager.getInstanceSync();
    } catch {
      // Never initialized — nothing to close.
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

  /** Bounded and error-isolated. Reads the telemetry manager at phase-5 time. */
  private async flushTelemetry(): Promise<void> {
    let telemetry: TelemetryManager | undefined;
    try {
      telemetry = TelemetryManager.getInstance();
    } catch {
      // Unavailable or mocked away — nothing to flush.
      return;
    }
    if (!telemetry) return;
    try {
      await this.raceWithTimeout(
        telemetry.shutdown(),
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
