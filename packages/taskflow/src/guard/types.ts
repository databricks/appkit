import type { IdempotencyKey, TaskName, UserId } from "@/core/branded";
import type { Task } from "@/domain";

/**
 * Configuration for rate limiting and admission control
 */
export interface BackpressureConfig {
  /** Size of the sliding window in milliseconds */
  windowSizeMs: number;
  /** Maximum tasks allowed per window (global) */
  maxTasksPerWindow: number;
  /** Maximum tasks allowed per user per window */
  maxTasksPerUserWindow: number;
  /** Maximum tasks that can be queued globally */
  maxQueuedSize: number;
}

/**
 * Reason for rejecting a task admission
 */
export type RejectionReason =
  | "global_rate_limit"
  | "user_rate_limit"
  | "queue_full"
  | "in_dlq";

/**
 * Statistics for a single window
 */
export interface WindowStats {
  /** Tasks accepted in current window */
  accepted: number;
  /** Tasks rejected in current window */
  rejected: number;
  /** Window start timestamp */
  startedAt: number;
}

/**
 * Statistics for admission control
 */
export interface AdmissionStats {
  /** Current configuration */
  config: BackpressureConfig;
  /** Current window statistics */
  window: WindowStats;
  /** Rejection breakdown by reason */
  rejections: {
    byReason: Record<RejectionReason, number>;
    lastAt?: number;
  };
  /** Lifetime totals */
  totals: {
    accepted: number;
    rejected: number;
  };
}

/**
 * Configuration for execution slot management
 */
export interface SlotManagerConfig {
  /** Maximum concurrent executions globally */
  maxExecutionGlobal: number;
  /** Maximum concurrent executions per user */
  maxExecutionPerUser: number;
  /** Timeout for acquiring a slot in milliseconds */
  slotTimeoutMs: number;
}

/**
 * Statistics for slot management
 */
export interface SlotStats {
  /** Current slot state */
  current: {
    /** Slots currently in use */
    inUse: number;
    /** Tasks waiting for a slot */
    waiting: number;
    /** Available slots */
    available: number;
  };
  /** Configuration limits */
  limits: {
    global: number;
    perUser: number;
  };
  /** Slot events */
  events: {
    /** Number of timeout events */
    timeouts: number;
    /** Total slots acquired     */
    acquired: number;
    /** Total slots released */
    released: number;
  };
}

/**
 * Event types emitted by the DLQ
 */
export type DLQEventType =
  | "dlq:added"
  | "dlq:removed"
  | "dlq:retried"
  | "dlq:expired"
  | "dlq:evicted"
  | "dlq:retry_exhausted";

/**
 * Event emitted when DLQ state changes
 */
export interface DLQEvent {
  type: DLQEventType;
  idempotencyKey: IdempotencyKey;
  taskName: TaskName;
  userId?: UserId;
  reason?: string;
  timestamp: number;
  retryAttempt?: number;
  error?: string;
}

/**
 * An entry in the dead letter queue
 */
export interface DLQEntry {
  /** The failed task */
  task: Task;
  /** When the task was added to DLQ */
  addedAt: number;
  /** Reason for adding to DLQ */
  reason?: string;
  /** Number of retry attempts from DLQ */
  retryCount: number;
  /** Last retry attempt timestamp */
  lastRetryAt?: number;
  /** Last error message */
  error?: string;
}

/**
 * Configuration for the dead letter queue
 */
export interface DLQConfig {
  /** Maximum number of entries in DLQ */
  maxSize: number;
  /** Time-to-live for DLQ entries in milliseconds */
  ttlMs: number;
  /** Cleanup interval in milliseconds */
  cleanupIntervalMs: number;
  /** Maximum retry attempts for DLQ */
  maxRetries: number;
}

/**
 * Statistics for the dead letter queue
 */
export interface DLQStats {
  /** Current size */
  size: number;
  /** Entries grouped by reason */
  byReason: Record<RejectionReason, number>;
  /** Total entries ever added */
  totalAdded: number;
  /** Total entries removed */
  totalRemoved: number;
  /** Total entries expired */
  totalExpired: number;
  /** Total entries evicted (due to capacity) */
  totalEvicted: number;
  /** Total retry attempts */
  totalRetries: number;
  /** Average age of entries in milliseconds */
  avgAgeMs: number;
  /** Age of oldest entry in milliseconds */
  oldestAgeMs: number;
  /** Last event timestamp */
  lastEventAt: number;
}

/**
 * Callback for DLQ events
 */
export type DLQEventListener = (event: DLQEvent) => void;

/**
 * Configuration for recovery slots (separate pool from execution slots)
 */
export interface RecoverySlotConfig {
  /** Maximum concurrent recovery operations */
  maxRecoverySlots: number;
  /** Timeout for acquiring a recovery slot */
  recoverySlotTimeoutMs: number;
}

/**
 * Statistics for recovery slots
 */
export interface RecoverySlotStats {
  /** Slots currently in use */
  inUse: number;
  /** Maximum slots available */
  limit: number;
  /** Available slots */
  available: number;
}

/**
 * Combined statistics from all guard components
 */
export interface GuardStats {
  admission: AdmissionStats;
  slots: SlotStats;
  dlq: DLQStats;
  recovery: RecoverySlotStats;
}

/**
 * Guard configuration combined all sub-configs
 */

export interface GuardConfig {
  backpressure: BackpressureConfig;
  slots: SlotManagerConfig;
  dlq: DLQConfig;
  recovery: RecoverySlotConfig;
}

/**
 * Default guard configuration values
 */
export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  backpressure: {
    windowSizeMs: 60_000, // 1 minute
    maxTasksPerWindow: 1000,
    maxTasksPerUserWindow: 100,
    maxQueuedSize: 500,
  },
  slots: {
    maxExecutionGlobal: 50,
    maxExecutionPerUser: 10,
    slotTimeoutMs: 30_000, // 30 seconds
  },
  dlq: {
    maxSize: 1000,
    ttlMs: 24 * 60 * 60 * 1000, // 24 hours
    cleanupIntervalMs: 60_000, // 1 minute
    maxRetries: 3,
  },
  recovery: {
    maxRecoverySlots: 10,
    recoverySlotTimeoutMs: 60_000, // 1 minute
  },
};
