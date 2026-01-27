import type { IdempotencyKey, UserId } from "@/core/branded";
import type { StreamStats } from "@/delivery/types";
import type { Task, TaskEvent, TaskExecutionOptions } from "@/domain";
import type { FlushStats } from "@/flush";
import type { GuardStats } from "@/guard/types";
import type { EventLogStats } from "@/persistence";

/**
 * Retry configuration for task execution
 */
export interface RetryConfig {
  /** maximum number of retry attempts */
  maxAttempts: number;
  /** initial delay in milliseconds before the first retry */
  initialDelayMs: number;
  /** maximum delay in milliseconds between retries */
  maxDelayMs: number;
  /** multiplier for exponential backoff */
  backoffMultiplier: number;
}

/**
 * Default retry configuration
 */

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Configuration for TaskExecutor
 */
export interface ExecutorConfig {
  /** interval between heartbeat emissions in milliseconds */
  heartbeatIntervalMs: number;
  /** retry configuration */
  retry: RetryConfig;
}

/**
 * Default executor configuration
 */
export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  heartbeatIntervalMs: 30_000, // 30 seconds
  retry: DEFAULT_RETRY_CONFIG,
};

/**
 * Subscriber interface for task events
 */
export interface TaskEventSubscriber {
  /** called when a task event is emitted */
  onEvent(idempotencyKey: IdempotencyKey, event: TaskEvent): void;
  /** called when a task completes (success, failure, or cancellation) */
  onComplete?(task: Task): void;
}

/**
 * Statistics for TaskExecutor
 */
export interface ExecutorStats {
  /** current state */
  current: {
    /** number of tasks currently executing */
    executing: number;
    /** number of active heartbeat timers */
    heartbeatsActive: number;
  };

  /** outcome counters */
  outcomes: {
    /** tasks completed successfully */
    completed: number;
    /** tasks that failed */
    failed: number;
    /** tasks that were cancelled */
    cancelled: number;
    /** tasks where handler was not found */
    handlerMissing: number;
    /** total tasks processed (sum of all outcomes) */
    total: number;
  };

  /** retry statistics */
  retries: {
    /** total retry attempts */
    attempted: number;
    /** successful retries (task succeeded after retry) */
    succeeded: number;
    /** retries exhausted (max attempts reached) */
    exhausted: number;
  };

  /** timing information */
  timing: {
    /** timestamp of last task start */
    lastStartAt?: number;
    /** timestamp of last task completion */
    lastCompleteAt?: number;
  };

  /** debug information */
  debug: {
    /** idempotency keys of currently executing tasks */
    executingTaskKeys: IdempotencyKey[];
  };
}

/**
 * Configuration for TaskRecovery
 */
export interface RecoveryConfig {
  /** whether background recovery is enabled */
  enabled: boolean;
  /** interval between background recovery scans in milliseconds */
  backgroundPollIntervalMs: number;
  /** threshold for considering a task stale (no heartbeat) in milliseconds */
  staleThresholdMs: number;
  /** maximum tasks to recover per scan */
  batchSize: number;
  /** timeout for waiting on a running task to complete in milliseconds */
  completionTimeoutMs: number;
  /** heartbeat interval for determining if a task is alive in milliseconds */
  heartbeatIntervalMs: number;
}

/**
 * Default recovery configuration
 */
export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  enabled: true,
  backgroundPollIntervalMs: 60_000, // 1 minute
  staleThresholdMs: 120_000, // 2 minutes
  batchSize: 10,
  completionTimeoutMs: 60_000, // 1 minute
  heartbeatIntervalMs: 30_000, // 30 seconds
};

/**
 * Statistics for TaskRecovery
 */
export interface RecoveryStats {
  /** configuration summary */
  config: {
    enabled: boolean;
    pollIntervalMs: number;
    staleThresholdMs: number;
    batchSize: number;
  };

  /** background scanner state */
  background: {
    /** whether a scan is currently in progress */
    isScanning: boolean;
    /** timestamp of last scan */
    lastScanAt?: number;
    /** duration of last scan in milliseconds */
    lastScanDurationMs?: number;
    /** timestamp of last error during scan */
    lastErrorAt?: number;
  };

  /** recovery outcome counters */
  outcomes: {
    /** background tasks recovered */
    background: number;
    /** user tasks recovered (via reconnection) */
    user: number;
    /** tasks that failed during recovery */
    failed: number;
    /** recovery method breakdown */
    byMethod: {
      /** tasks recovered using smart recovery handler */
      smartRecovery: number;
      /** tasks recovered by re-execution */
      reexecution: number;
    };
  };
}

/**
 * Task system status
 */
export type TaskSystemStatus =
  | "starting"
  | "running"
  | "degraded"
  | "shutting_down"
  | "stopped";

/**
 * Options for graceful shutdown
 */
export interface ShutdownOptions {
  /** delete event log files after shutdown */
  deleteFiles?: boolean;
  /** force immediate shutdown without waiting for tasks */
  force?: boolean;
}

/**
 * Configuration for graceful shutdown
 */
export interface ShutdownConfig {
  /** maximum time to wait for running tasks in milliseconds */
  gracePeriodMs: number;
  /** interval for polling task completion in milliseconds */
  pollIntervalMs: number;
}

/**
 * default shutdown configuration
 */
export const DEFAULT_SHUTDOWN_CONFIG: ShutdownConfig = {
  gracePeriodMs: 30_000,
  pollIntervalMs: 100,
};

/**
 * Comprehensive statistics for the entire TaskSystem
 */
export interface TaskSystemStats {
  /** system health and lifecycle */
  system: {
    status: TaskSystemStatus;
    startedAt?: number;
    uptimeMs?: number;
  };

  /** high-level task counts */
  tasks: {
    /** tasks in pending queue */
    queued: number;
    /** tasks waiting for execution slot */
    waiting: number;
    /** tasks currently executing */
    executing: number;
    /** tasks in dead letter queue */
    inDLQ: number;
    /** total in-flight (queued + waiting + executing) */
    inFlight: number;
    /** lifetime completed tasks */
    totalCompleted: number;
    /** lifetime failed tasks */
    totalFailed: number;
    /** lifetime cancelled tasks */
    totalCancelled: number;
    /** success rate (completed / (completed + failed)) */
    successRate?: number;
  };

  /** scheduler state */
  scheduler: {
    /** tick interval in milliseconds */
    tickIntervalMs: number;
    /** whether a tick is currently active */
    isTickActive: boolean;
  };

  /** registry information */
  registry: {
    /** number of registered templates */
    templates: number;
    /** number of registered handlers */
    handlers: number;
  };

  /** component-specific statistics */
  components: {
    guard: GuardStats;
    executor: ExecutorStats;
    stream: StreamStats;
    eventLog: EventLogStats;
    flush: FlushStats;
    recovery: RecoveryStats;
  };
}

/**
 * Parameters for running a task
 */
export interface TaskRunParams {
  /** user id for user-initiated tasks */
  userId: UserId | null;
  /** task input data */
  input: unknown;
  /** custom idempotency key (optional, auto-generated if not provided) */
  idempotencyKey?: IdempotencyKey;
  /** custom execution options (optional) */
  executionOptions?: TaskExecutionOptions;
}

/**
 * Parameters for recovering a task
 */
export interface TaskRecoveryParams {
  /** idempotency key of the task to recover */
  idempotencyKey: IdempotencyKey;
  /** user id requesting recovery (for authorization) */
  userId: UserId | null;
}

/**
 * Options for streaming task events
 */
export interface TaskStreamOptions {
  /** last received sequence number for reconnection */
  lastSeq?: number;
  /** abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Task template returned by registerTask
 */
export interface TaskTemplate {
  /** template name */
  name: string;
  /** run a new task */
  run: (params: TaskRunParams) => Promise<Task>;
  /** recover an existing task */
  recover: (params: TaskRecoveryParams) => Promise<Task | null>;
}

/**
 * Merge helper for executor config
 */

export function mergeExecutorConfig(
  partial?: Partial<ExecutorConfig>,
): ExecutorConfig {
  if (!partial) return DEFAULT_EXECUTOR_CONFIG;

  return {
    heartbeatIntervalMs:
      partial.heartbeatIntervalMs ??
      DEFAULT_EXECUTOR_CONFIG.heartbeatIntervalMs,
    retry: {
      ...DEFAULT_RETRY_CONFIG,
      ...partial.retry,
    },
  };
}

/**
 * Merge helper for recovery config
 */
export function mergeRecoveryConfig(
  partial?: Partial<RecoveryConfig>,
): RecoveryConfig {
  if (!partial) return DEFAULT_RECOVERY_CONFIG;

  return {
    ...DEFAULT_RECOVERY_CONFIG,
    ...partial,
  };
}

/**
 * Merge helper for shutdown config
 */
export function mergeShutdownConfig(
  partial?: Partial<ShutdownConfig>,
): ShutdownConfig {
  if (!partial) return DEFAULT_SHUTDOWN_CONFIG;

  return {
    ...DEFAULT_SHUTDOWN_CONFIG,
    ...partial,
  };
}
