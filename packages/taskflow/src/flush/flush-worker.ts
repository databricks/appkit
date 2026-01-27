import fs from "node:fs/promises";
import {
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  TaskSpans,
  type TaskSystemHooks,
} from "@/observability";
import { EventLog, type TaskRepository } from "@/persistence";
import {
  DEFAULT_FLUSH_CONFIG,
  type FlushConfig,
  type FlushWorkerRuntimeStats,
  type FlushWorkerStats,
} from "./types";

/**
 * FlushWorker - Reads events from EventLog and flushes to repository
 */
export class FlushWorker {
  private readonly config: Required<Omit<FlushConfig, "repository">>;
  private readonly repository: TaskRepository;
  private readonly hooks: TaskSystemHooks;
  private readonly eventLog: EventLog;

  private checkpoint: number = 0;
  private isShuttingDown: boolean = false;
  private _isRunning: boolean = false;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private circuitBreakerOpenUntil: number | null = null;

  private stats: FlushWorkerStats = {
    flushCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    totalEntriesFlushed: 0,
    lastFlushAt: null,
    lastErrorAt: null,
  };

  constructor(
    config: Partial<FlushConfig>,
    repository: TaskRepository,
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.config = { ...DEFAULT_FLUSH_CONFIG, ...config };
    this.repository = repository;
    this.hooks = hooks;
    this.eventLog = new EventLog(
      {
        eventLogPath: this.config.eventLogPath,
      },
      hooks,
    );
  }

  /**
   * Start the flush worker
   * - Initialize repository
   * - Load checkpoint from file
   * - Start periodic flush interval
   */
  async start(): Promise<void> {
    await this.repository.initialize();
    this.checkpoint = await this.loadCheckpoint();

    this.flushInterval = setInterval(async () => {
      await this.flush();
    }, this.config.flushIntervalMs);

    // don't keep process alive just for flush interval
    this.flushInterval.unref();

    this._isRunning = true;

    this.hooks.log({
      severity: "info",
      message: "FlushWorker started",
      attributes: {
        checkpoint: this.checkpoint,
        flushInterval: this.config.flushIntervalMs,
      },
    });
  }

  /**
   * Stop the flush worker loop
   */
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this._isRunning = false;

    this.hooks.log({
      severity: "info",
      message: "FlushWorker stopped",
      attributes: {
        checkpoint: this.checkpoint,
      },
    });
  }

  /**
   * Graceful shutdown - drain remaining events before stopping
   * @param timeoutMs - Maximum time to wait for draining
   */
  async gracefulShutdown(timeoutMs: number = 30_000): Promise<void> {
    this.isShuttingDown = true;
    this.stop();

    const startTime = Date.now();

    // drain remaining events
    while (Date.now() - startTime < timeoutMs) {
      const entries = await this.eventLog.readEntriesFromCheckpoint(
        this.checkpoint,
      );

      if (entries.length === 0) break;

      try {
        await this.flush();
      } catch (error) {
        this.hooks.log({
          severity: "error",
          message: "Error during graceful shutdown flush",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }

      // small delay between flush attempts
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await this.repository.close();

    this.hooks.log({
      severity: "info",
      message: "FlushWorker shutdown complete",
      attributes: {
        totalEntriesFlushed: this.stats.totalEntriesFlushed,
        durationMs: Date.now() - startTime,
      },
    });
  }

  /**
   * Flush entries from EventLog to repository
   */
  async flush(): Promise<void> {
    // skip if not running (unless shutting down - need to drain)
    if (!this.isShuttingDown && !this._isRunning) return;

    // skip if circuit breaker is open
    if (this.isCircuitOpen()) return;

    const startTime = Date.now();

    return this.hooks.withSpan(
      TaskSpans.FLUSH_BATCH,
      {
        [TaskAttributes.REPOSITORY_TYPE]: this.repository.type,
      },
      async (span) => {
        let batch = await this.eventLog.readEntriesFromCheckpoint(
          this.checkpoint,
        );

        if (batch.length === 0) return;

        // limit batch size
        if (batch.length > this.config.maxBatchSize) {
          batch = batch.slice(0, this.config.maxBatchSize);
        }

        span.setAttribute(TaskAttributes.FLUSH_BATCH_SIZE, batch.length);

        // retry loop with exponential backoff
        for (
          let attempt = 1;
          attempt <= this.config.maxFlushRetries;
          attempt++
        ) {
          try {
            await this.repository.executeBatch(batch);
            await this.saveCheckpoint(this.checkpoint + batch.length);

            // update stats on success
            this.stats.lastFlushAt = Date.now();
            this.stats.flushCount++;
            this.stats.totalEntriesFlushed += batch.length;
            this.stats.consecutiveErrors = 0;

            // record metrics
            this.hooks.incrementCounter(TaskMetrics.FLUSH_BATCHES, 1, {
              [TaskAttributes.REPOSITORY_TYPE]: this.repository.type,
            });

            this.hooks.incrementCounter(
              TaskMetrics.FLUSH_ENTRIES,
              batch.length,
              {
                [TaskAttributes.REPOSITORY_TYPE]: this.repository.type,
              },
            );

            this.hooks.recordHistogram(
              TaskMetrics.FLUSH_DURATION_MS,
              Date.now() - startTime,
              {
                [TaskAttributes.REPOSITORY_TYPE]: this.repository.type,
              },
            );

            this.hooks.recordHistogram(
              TaskMetrics.FLUSH_BATCH_SIZE,
              batch.length,
              {
                [TaskAttributes.REPOSITORY_TYPE]: this.repository.type,
              },
            );

            span.setStatus("ok");
            return;
          } catch (error) {
            this.hooks.log({
              severity: "error",
              message: `Flush attempt ${attempt}/${this.config.maxFlushRetries} failed`,
              error: error instanceof Error ? error : new Error(String(error)),
              attributes: {
                attempt,
                maxAttempts: this.config.maxFlushRetries,
              },
            });

            this.stats.errorCount++;
            this.stats.lastErrorAt = Date.now();
            this.stats.consecutiveErrors++;

            this.hooks.incrementCounter(TaskMetrics.FLUSH_ERRORS, 1, {
              [TaskAttributes.REPOSITORY_TYPE]: this.repository.type,
            });

            if (attempt < this.config.maxFlushRetries) {
              // exponential backoff
              const delay = this.config.retryBaseDelayMs * 2 ** (attempt - 1);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }

        // all retries exhausted - check circuit breaker
        if (this.stats.consecutiveErrors >= this.config.circuitBreakerThreshold)
          this.openCircuitBreaker();

        span.setStatus("error", "All flush retries exhausted");
      },
    );
  }

  /**
   * Whether the worker is currently running
   */
  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get current worker statistics
   */
  getStats(): FlushWorkerRuntimeStats {
    return {
      ...this.stats,
      isRunning: this._isRunning,
      isShuttingDown: this.isShuttingDown,
      isCircuitOpen: this.isCircuitOpen(),
    };
  }

  /**
   * Save checkpoint atomically using write-then-rename
   */
  private async saveCheckpoint(newCheckpoint: number): Promise<void> {
    const checkpointPath = this.getCheckpointPath();
    const tempPath = `${checkpointPath}.temp`;

    // write new checkpoint
    await fs.writeFile(tempPath, newCheckpoint.toString(), "utf-8");
    await fs.rename(tempPath, checkpointPath);

    this.checkpoint = newCheckpoint;
  }

  /**
   * Load checkpoint from file, returns 0 if not found or invalid
   */
  private async loadCheckpoint(): Promise<number> {
    const checkpointPath = this.getCheckpointPath();

    try {
      const content = await fs.readFile(checkpointPath, "utf-8");
      const parsed = parseInt(content.trim(), 10);

      if (Number.isNaN(parsed) || parsed < 0) {
        this.hooks.log({
          severity: "warn",
          message: `Invalid checkpoint value: ${content.trim()}, resetting to 0`,
        });
        return 0;
      }

      return parsed;
    } catch (error) {
      // file doesn't exist or can't be read
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return 0;
      throw error;
    }
  }

  /**
   * Open the circuit breaker to block flushes temporarily
   */
  private openCircuitBreaker(): void {
    this.circuitBreakerOpenUntil =
      Date.now() + this.config.circuitBreakerDurationMs;

    this.hooks.log({
      severity: "warn",
      message: `Circuit breaker opened, blocking flushes for ${this.config.circuitBreakerDurationMs}ms`,
      attributes: {
        consecutiveErrors: this.stats.consecutiveErrors,
        threshold: this.config.circuitBreakerThreshold,
      },
    });
  }

  /**
   * Check if circuit breaker is currently open
   */
  private isCircuitOpen(): boolean {
    if (this.circuitBreakerOpenUntil === null) return false;

    if (Date.now() >= this.circuitBreakerOpenUntil) {
      this.circuitBreakerOpenUntil = null;
      this.hooks.log({
        severity: "info",
        message: "Circuit breaker reset, resuming flushes",
      });
      return false;
    }

    return true;
  }

  /**
   * Get the checkpoint file path
   */
  private getCheckpointPath(): string {
    return `${this.config.eventLogPath}.flush-checkpoint`;
  }
}
