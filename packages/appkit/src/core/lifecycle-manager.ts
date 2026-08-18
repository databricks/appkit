import type { BasePlugin } from "shared";

import { CacheManager } from "../cache";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";
import type { PluginContext } from "./plugin-context";
import { resetCoreSingletons } from "./reset-singletons";

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
   * Default budget for {@link close}. Deliberately shorter than
   * {@link SHUTDOWN_TIMEOUT_MS}: the signal path is racing a container's kill
   * deadline and wants every available second, whereas a programmatic caller
   * (a test harness, an embedding host) wants its `await` back promptly.
   */
  private static readonly CLOSE_TIMEOUT_MS = 5_000;

  /**
   * The in-flight teardown, memoized. Guards against re-entrant shutdown
   * (e.g. SIGTERM followed by SIGINT) *and* gives every later caller
   * something to await.
   *
   * This replaces an `isShuttingDown` boolean, which made a second caller
   * return immediately while teardown was still running. Harmless for a
   * signal — the first caller exits the process anyway — but for `close()` it
   * would resolve before resources were released, which is the difference
   * between a correct handle and a misleading one.
   */
  private teardown: Promise<number> | undefined;
  /**
   * Name of the shutdown phase currently in flight, so the force-exit log
   * can say where shutdown got stuck without extra bookkeeping.
   */
  private shutdownPhase = "not started";
  /**
   * The exact `[signal, handler]` pairs this instance registered, so
   * {@link close} can remove its own listeners and nothing else.
   */
  private signalHandlers: [NodeJS.Signals, () => void][] = [];

  constructor(private readonly context: PluginContext) {}

  /**
   * Install the SIGTERM/SIGINT handlers that trigger {@link shutdown}.
   *
   * Uses `process.once` (not `on`) so a repeated signal cannot register the
   * handler twice; re-entrancy from a *different* signal is guarded by the
   * {@link teardown} memo.
   *
   * The handler references are retained because anonymous arrows cannot be
   * removed later — {@link close} needs to detach exactly these.
   */
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
   * Detach the signal handlers this instance installed.
   *
   * Removes the retained pairs individually rather than calling
   * `removeAllListeners(signal)`, so a host process that embeds AppKit keeps
   * its own SIGTERM/SIGINT handlers.
   */
  removeSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];
  }

  /**
   * Run the graceful-shutdown sequence and **exit the process**. This is the
   * signal path; {@link close} is the programmatic one that runs the same
   * phases without exiting.
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
   * One behaviour changed when `close()` was added: a *second* signal now
   * awaits the first teardown instead of returning immediately. The first
   * caller still exits the process, so this is unobservable in production.
   */
  async shutdown(): Promise<void> {
    // Force exit once the overall budget is spent. Exit 0 is deliberate:
    // a force-timeout still happens on a routine deploy (deliberate
    // shutdown, not a crash), and orchestrators record nonzero exits on
    // deploys as crashes. The error log below is the stuck-shutdown
    // signal instead of the exit code.
    //
    // The timer lives here rather than in the phase runner because it is the
    // one thing `close()` must not inherit: a programmatic caller wants a
    // rejected/logged promise when teardown hangs, not a dead process.
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

    const exitCode = await this.runOnce();

    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }

  /**
   * Release everything AppKit acquired **without terminating the process**.
   *
   * The programmatic twin of {@link shutdown}: same phases, same per-phase
   * budgets, no `process.exit` and no force-exit timer. This is what makes an
   * app handle's `close()` — and therefore repeated boots inside one test file
   * — possible.
   *
   * Signal handlers are detached **before the first `await`**, which shrinks
   * the SIGTERM-mid-close window to near zero. The four orderings:
   *
   * | Order | Outcome |
   * | --- | --- |
   * | `close()` twice | Second awaits the same memo; teardown runs once |
   * | `close()` then SIGTERM | AppKit no longer listens, so Node's default terminates. Correct: the host asked AppKit to release its resources, and owns its own signal policy from then on. |
   * | SIGTERM mid-`close()` | Narrow window; the handler joins the memo and then exits. **The signal wins** — it wanted the process dead — so `close()`'s promise never settles. Documented, not "fixed". |
   * | SIGTERM then `close()` | `close()` joins the memo; the signal path exits when the phases finish |
   *
   * Never throws: a hung phase is logged (naming the phase) and `close()`
   * resolves once its budget is spent, so an `afterEach` cannot hang forever.
   *
   * @param options.timeoutMs - Overall budget. Defaults to
   *   {@link LifecycleManager.CLOSE_TIMEOUT_MS}.
   */
  async close(options: { timeoutMs?: number } = {}): Promise<void> {
    // Before the first await: a signal arriving after this point finds no
    // AppKit listener, so it cannot re-enter the sequence.
    this.removeSignalHandlers();

    const timeoutMs = options.timeoutMs ?? LifecycleManager.CLOSE_TIMEOUT_MS;

    try {
      await this.raceWithTimeout(this.runOnce(), timeoutMs, "close");
    } catch (err) {
      logger.error(
        "close() did not complete within the %dms budget (phase in flight: %s): %O",
        timeoutMs,
        this.shutdownPhase,
        err,
      );
    }

    // Only on this path. On the signal path the process is dying, so dropping
    // singleton pointers is pure cost. Safe here because the phases above
    // already closed the cache storage and flushed telemetry, so these are
    // pointer drops over released resources.
    resetCoreSingletons();
  }

  /**
   * Memoize the teardown so it runs exactly once and every caller awaits the
   * same result.
   *
   * There must be no `await` between reading and assigning `this.teardown` —
   * that gap is precisely the re-entrancy window the old synchronous
   * `isShuttingDown` flag was protecting.
   */
  private runOnce(): Promise<number> {
    this.teardown ??= this.runPhases();
    return this.teardown;
  }

  /**
   * Run the shutdown phases and report the exit code the signal path should
   * use. Contains no process-termination concerns of its own.
   */
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
