import type { RepositoryConfig } from "@/persistence/repository";

/**
 * Flush configuration options
 */
export interface FlushConfig {
  /** interval between flush attempts in milliseconds */
  flushIntervalMs: number;
  /** path to the event log file */
  eventLogPath: string;
  /** maximum number of entries to flush per batch */
  maxBatchSize: number;
  /** maximum number of retry attempts per flush */
  maxFlushRetries: number;
  /** base delay for exponential backoff in milliseconds */
  retryBaseDelayMs: number;
  /** duration to keep circuit breaker open in milliseconds */
  circuitBreakerDurationMs: number;
  /** number of consecutive errors before opening circuit breaker */
  circuitBreakerThreshold: number;
  /** interval between health checks in milliseconds */
  healthCheckIntervalMs: number;
  /** maximum number of worker restarts */
  maxRestarts: number;
  /** delay between restart attempts in milliseconds */
  restartDelayMs: number;
  /** repository configuration */
  repository: RepositoryConfig;
}

/**
 * Default flush configuration values
 */

export const DEFAULT_FLUSH_CONFIG: Required<Omit<FlushConfig, "repository">> = {
  flushIntervalMs: 1000,
  eventLogPath: "./.taskflow/event.log",
  maxBatchSize: 1000,
  maxFlushRetries: 3,
  retryBaseDelayMs: 100,
  circuitBreakerDurationMs: 30_000,
  circuitBreakerThreshold: 5,
  healthCheckIntervalMs: 5000,
  maxRestarts: 3,
  restartDelayMs: 1000,
};

/**
 * Statistics tracked by the flush worker
 */
export interface FlushWorkerStats {
  /** number of successful flush operations */
  flushCount: number;
  /** total number of errors encountered */
  errorCount: number;
  /** number of consecutive errors (resets on success) */
  consecutiveErrors: number;
  /** total number of entries flushed to repository */
  totalEntriesFlushed: number;
  /** timestamp of last successful flush */
  lastFlushAt: number | null;
  /** timestamp of last error */
  lastErrorAt: number | null;
}

/**
 * Extended worker stats including runtime state
 */
export interface FlushWorkerRuntimeStats extends FlushWorkerStats {
  /** whether the worker is running */
  isRunning: boolean;
  /** whether the worker is shutting down */
  isShuttingDown: boolean;
  /** whether the circuit breaker is open */
  isCircuitOpen: boolean;
}

/**
 * Messages sent from worker to manager
 */
export type IPCMessage =
  | { type: "ready" }
  | { type: "stats"; payload: FlushWorkerRuntimeStats }
  | { type: "shutdown-complete" }
  | { type: "error"; payload: string };

/**
 * Commands sent from manager to worker
 */
export type IPCCommand =
  | { type: "shutdown"; payload: { timeoutMs: number } }
  | { type: "get-stats" };

/**
 * Manager's view of worker status
 */
export interface FlushStatus {
  /** whether the worker process is alive */
  isAlive: boolean;
  /** whether the manager is shutting down */
  isShuttingDown: boolean;
  /** number of times the worker has been restarted */
  restartCount: number;
  /** PID of the worker process */
  pid: number | null;
  /** last known worker stats */
  lastStats: FlushWorkerStats | null;
}

/**
 * Combined process and worker statistics
 */
export interface FlushStats {
  /** process-level statistics */
  process: {
    isAlive: boolean;
    pid: number | null;
    restartCount: number;
    isShuttingDown: boolean;
  };
  /** worker-level statistics (null if worker not running) */
  worker: {
    isRunning: boolean;
    flushCount: number;
    errorCount: number;
    consecutiveErrors: number;
    totalEntriesFlushed: number;
    lastFlushAt: number | null;
    lastErrorAt: number | null;
  } | null;
}
