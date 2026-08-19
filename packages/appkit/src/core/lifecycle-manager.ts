import type { BasePlugin } from "shared";

import { CacheManager } from "../cache";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";
import type { PluginContext } from "./plugin-context";
import { releaseCoreSingletons } from "./reset-singletons";

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

  /** Shorter than the signal path's: a programmatic caller wants its await back. */
  private static readonly CLOSE_TIMEOUT_MS = 5_000;

  /**
   * The in-flight teardown, memoized. A boolean guard would let a second caller
   * return while teardown was still running — fine for a signal, wrong for
   * `close()`, which must not resolve before resources are released.
   */
  private teardown: Promise<number> | undefined;
  /** Reported by the force-exit log so a stuck shutdown names its phase. */
  private shutdownPhase = "not started";
  /** Retained so {@link close} removes its own listeners and nothing else. */
  private signalHandlers: [NodeJS.Signals, () => void][] = [];
  /** Memoizes {@link close}, so the singleton release happens once. */
  private closed: Promise<void> | undefined;

  constructor(private readonly context: PluginContext) {}

  /** Install the SIGTERM/SIGINT handlers that trigger {@link shutdown}. */
  installSignalHandlers(): void {
    this.signalHandlers = [
      ["SIGTERM", () => void this.shutdown()],
      ["SIGINT", () => void this.shutdown()],
    ];
    for (const [signal, handler] of this.signalHandlers) {
      process.once(signal, handler);
    }
  }

  /**
   * Detach only this instance's handlers — never `removeAllListeners`, so an
   * embedding host keeps its own.
   */
  removeSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];
  }

  /**
   * Run the graceful-shutdown sequence and **exit the process**. See
   * {@link close} for the non-exiting twin.
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
   *
   * A second signal now awaits the first teardown rather than returning at once;
   * the first caller still exits, so this is unobservable in production.
   */
  async shutdown(): Promise<void> {
    // Exit 0 on force-timeout: a stuck deploy shutdown is not a crash, and
    // orchestrators read nonzero deploy exits as one. The error log is the
    // signal instead. Lives here, not in runPhases, because close() must not
    // inherit it.
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

    const exitCode = await this.runOnce();

    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }

  /**
   * Release everything AppKit acquired **without terminating the process** —
   * same phases and per-phase budgets as {@link shutdown}, no `process.exit`.
   *
   * Handlers are detached before the first `await`, so the SIGTERM-mid-close
   * window is near zero; if one does land there the signal wins and this promise
   * never settles. Never throws — a hung phase is logged and `close()` resolves
   * once its budget is spent, so an `afterEach` cannot hang.
   */
  async close(options: { timeoutMs?: number } = {}): Promise<void> {
    // Memoized separately from the phases: `runOnce()` already guarantees the
    // teardown body runs once, but the singleton reset below must also happen
    // once. Without this a stale handle's second close() resets whatever app is
    // live *now* — `await a.close(); createApp(); await a.close()` broke the
    // second app.
    this.closed ??= this.closeOnce(options);
    return this.closed;
  }

  private async closeOnce(options: { timeoutMs?: number }): Promise<void> {
    // Before the first await, so a later signal finds no AppKit listener.
    this.removeSignalHandlers();

    const timeoutMs = options.timeoutMs ?? LifecycleManager.CLOSE_TIMEOUT_MS;

    let timedOut = false;
    try {
      await this.raceWithTimeout(this.runOnce(), timeoutMs, "close");
    } catch (err) {
      timedOut = true;
      logger.error(
        "close() did not complete within the %dms budget (phase in flight: %s): %O",
        timeoutMs,
        this.shutdownPhase,
        err,
      );
    }

    // Skipped on timeout: the phases are still running and still own these
    // instances, so dropping the pointers now would hand the next boot a
    // half-released app. Skipped on the signal path too, where the process is
    // dying and this is pure cost.
    if (!timedOut) releaseCoreSingletons();
  }

  /** No `await` between read and assign — that gap is the re-entrancy window. */
  private runOnce(): Promise<number> {
    this.teardown ??= this.runPhases();
    return this.teardown;
  }

  /** Run the phases and report an exit code; no process-termination concerns. */
  private async runPhases(): Promise<number> {
    logger.info("Starting graceful shutdown...");

    // Captured before the first await and never re-read: close() may give up
    // waiting and reset the singletons while these phases still run, so phase 5
    // would otherwise skip this app's pool or tear down the *next* app's.
    let capturedCache: CacheManager | undefined;
    try {
      capturedCache = CacheManager.getInstanceSync();
    } catch {
      // Never initialized — nothing to close in phase 5.
    }
    let capturedTelemetry: TelemetryManager | undefined;
    try {
      capturedTelemetry = TelemetryManager.getInstance();
    } catch {
      // Unavailable or mocked away — nothing to flush.
    }

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
      await Promise.all([
        this.closeCacheStorage(capturedCache),
        this.flushTelemetry(capturedTelemetry),
      ]);

      logger.info("Graceful shutdown complete");
    } catch (err) {
      // Exit 1 is reserved for an unexpected error thrown by the sequence
      // itself; every per-phase failure above is already caught and logged.
      logger.error("Error during graceful shutdown: %O", err);
      exitCode = 1;
    }

    return exitCode;
  }

  /** Bounded and error-isolated. Takes the manager — see the capture in {@link runPhases}. */
  private async closeCacheStorage(
    cache: CacheManager | undefined,
  ): Promise<void> {
    if (!cache) {
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

  /** Bounded and error-isolated. Takes the manager — see {@link closeCacheStorage}. */
  private async flushTelemetry(
    telemetry: TelemetryManager | undefined,
  ): Promise<void> {
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
