import fs from "node:fs/promises";
import path from "node:path";
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

  private byteOffset: number = 0;
  private isShuttingDown: boolean = false;
  private _isRunning: boolean = false;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private circuitBreakerOpenUntil: number | null = null;

  private currentBatchSize: number;

  private stats: FlushWorkerStats = {
    flushCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    totalEntriesFlushed: 0,
    lastFlushAt: null,
    lastErrorAt: null,
    lastError: null,
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
    this.currentBatchSize = this.config.minBatchSize;
  }

  /**
   * Start the flush worker
   * - Initialize repository
   * - Ensure checkpoint directory exists
   * - Load checkpoint from file
   * - Start periodic flush interval
   */
  async start(): Promise<void> {
    await this.repository.initialize();

    // ensure checkpoint directory exists
    const checkpointDir = path.dirname(this.getCheckpointPath());
    await fs.mkdir(checkpointDir, { recursive: true });

    // load byte offset from checkpoint file
    this.byteOffset = await this.loadByteOffset();

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
        byteOffset: this.byteOffset,
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
        byteOffset: this.byteOffset,
      },
    });
  }

  /**
   * Graceful shutdown - drain remaining events before stopping
   * @param timeoutMs - Maximum time to wait for draining
   * @param onStats - Optional callback to send stats to parent process
   */
  async gracefulShutdown(
    timeoutMs: number = 30_000,
    onStats?: (stats: FlushWorkerRuntimeStats) => void,
  ): Promise<void> {
    this.isShuttingDown = true;
    this.stop();

    const startTime = Date.now();

    // drain remaining events
    while (Date.now() - startTime < timeoutMs) {
      // check if there are any remaining entries
      const { entries: remaining } =
        await this.eventLog.readEntriesFromByteOffset(this.byteOffset, 1);

      if (remaining.length === 0) break;

      try {
        await this.flush();
        // send stats to parent process
        onStats?.(this.getStats());
      } catch (error) {
        this.hooks.log({
          severity: "error",
          message: "Error during graceful shutdown flush",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }

      // small delay between flush attempts
      await new Promise((resolve) => setTimeout(resolve, 50));
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
        // read entries from byte offset
        let batch: Awaited<
          ReturnType<typeof this.eventLog.readEntriesFromByteOffset>
        >["entries"];
        let newByteOffset: number;

        try {
          const result = await this.eventLog.readEntriesFromByteOffset(
            this.byteOffset,
            this.currentBatchSize,
          );
          batch = result.entries;
          newByteOffset = result.newByteOffset;
        } catch (error) {
          // handle file not found error
          if (
            error instanceof Error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            this.hooks.log({
              severity: "warn",
              message:
                "Event log file not found (rotation in progress?), will retry",
            });
            return;
          }
          throw error;
        }

        if (batch.length === 0) {
          // no work to do, shrink batch size
          this.adjustBatchSize(0);
          return;
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
            await this.saveByteOffset(newByteOffset);

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

            // adjust batch size based on how much work we got
            this.adjustBatchSize(batch.length);

            span.setStatus("ok");
            return;
          } catch (error) {
            // extract root cause from error
            const err = error as Error & { cause?: Error };
            const rootCause = err.cause?.message ?? null;
            const errorMessage = rootCause
              ? `${err.message} - Cause: ${rootCause}`
              : error instanceof Error
                ? error.message
                : String(error);

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
            this.stats.lastError = errorMessage;

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

  private async saveByteOffset(newByteOffset: number): Promise<void> {
    // update in-memory offset
    this.byteOffset = newByteOffset;

    const checkpointPath = this.getCheckpointPath();
    const tempPath = `${checkpointPath}.temp`;

    try {
      await fs.writeFile(tempPath, newByteOffset.toString(), "utf-8");
      await fs.rename(tempPath, checkpointPath);
    } catch (error) {
      // handle file not found error
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
          await fs.writeFile(tempPath, newByteOffset.toString(), "utf-8");
          await fs.rename(tempPath, checkpointPath);
        } catch (retryError) {
          // log error that checkpoint directory was deleted
          this.hooks.log({
            severity: "warn",
            message: "Failed to persist checkpoint to disk",
            error:
              retryError instanceof Error
                ? retryError
                : new Error(String(retryError)),
          });
        }
      } else {
        // log error that checkpoint file could not be saved
        this.hooks.log({
          severity: "warn",
          message: "Failed to save checkpoint",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  private async loadByteOffset(): Promise<number> {
    const checkpointPath = this.getCheckpointPath();

    try {
      const content = await fs.readFile(checkpointPath, "utf-8");
      const parsed = parseInt(content.trim(), 10);

      // check if byte offset is valid
      if (Number.isNaN(parsed) || parsed < 0) {
        this.hooks.log({
          severity: "warn",
          message: `Invalid byte offset value: ${content.trim()}, resetting to 0`,
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

  /**
   * Adjust batch size based on WAL lag heuristic
   */
  private adjustBatchSize(entriesRead: number): void {
    const { minBatchSize, maxBatchSize } = this.config;

    if (entriesRead === 0) {
      // no work to do, shrink batch size
      this.currentBatchSize = Math.max(
        minBatchSize,
        Math.floor(this.currentBatchSize * 0.75),
      );
    } else if (entriesRead >= this.currentBatchSize) {
      // full batch, grow aggressively
      this.currentBatchSize = Math.min(
        maxBatchSize,
        Math.floor(this.currentBatchSize * 1.5),
      );
    } else if (entriesRead < this.currentBatchSize * 0.5) {
      // less than half full, shrink gradually
      this.currentBatchSize = Math.max(
        minBatchSize,
        Math.floor(this.currentBatchSize * 0.9),
      );
    }
  }
}
