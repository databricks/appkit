import type { UserId } from "@/core/branded";
import { BackpressureError, ValidationError } from "@/core/errors";
import type { Task } from "@/domain";
import {
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  type TaskSystemHooks,
} from "@/observability";
import type {
  AdmissionStats,
  BackpressureConfig,
  RejectionReason,
  WindowStats,
} from "./types";

/**
 * Backpressure controller for rate limiting task admission
 *
 * Uses a sliding window algorithm to enforce:
 * - Global rate limits (tasks per window)
 * - Per-user rate limits (tasks per user per window)
 * - Queue capacity limits
 */
export class Backpressure {
  private readonly config: BackpressureConfig;
  private readonly hooks: TaskSystemHooks;

  // sliding window timestamps
  private globalTaskTimestamps: number[] = [];
  private userTaskTimestamps: Map<UserId, number[]> = new Map();

  // queue tracking
  private queueSize = 0;

  // statistics
  private windowStartedAt: number = Date.now();
  private acceptedInWindow = 0;
  private rejectedInWindow = 0;
  private rejectionsByReason: Record<RejectionReason, number> = {
    global_rate_limit: 0,
    user_rate_limit: 0,
    queue_full: 0,
    in_dlq: 0,
  };
  private lastRejectionAt?: number;
  private totalAccepted = 0;
  private totalRejected = 0;

  constructor(config: BackpressureConfig, hooks: TaskSystemHooks = noopHooks) {
    this.config = config;
    this.hooks = hooks;
  }

  /**
   * Check if a task can be admitted
   * @throws {ValidationError} if task is in DLQ
   * @throws {BackpressureError} if rate limits or queue capacity exceeded
   */
  accept(task: Task, isInDLQ: boolean): void {
    // check dlq first
    if (isInDLQ) {
      this.trackRejection("in_dlq", task);
      throw new ValidationError(
        "Task is in DLQ and cannot be resubmitted",
        "idempotencyKey",
        {
          taskId: task.id,
          idempotencyKey: task.idempotencyKey,
        },
      );
    }

    const now = Date.now();
    const windowStart = now - this.config.windowSizeMs;

    // cleanup expired timestamps
    this.globalTaskTimestamps = this.globalTaskTimestamps.filter(
      (ts) => ts >= windowStart,
    );

    // check global window limit
    if (this.globalTaskTimestamps.length >= this.config.maxTasksPerWindow) {
      const retryAfterMs = this.calculateRetryAfterMs(
        this.globalTaskTimestamps,
      );
      this.trackRejection("global_rate_limit", task);
      throw new BackpressureError(
        "Global rate limit exceeded",
        this.config.maxTasksPerWindow,
        this.config.maxTasksPerWindow - this.globalTaskTimestamps.length,
        retryAfterMs,
        {
          taskId: task.id,
          taskName: task.name,
        },
      );
    }

    // check per-user window limit
    if (task.userId) {
      const userTimestamps = this.userTaskTimestamps.get(task.userId) ?? [];
      const filteredUserTimestamps = userTimestamps.filter(
        (ts) => ts >= windowStart,
      );
      this.userTaskTimestamps.set(task.userId, filteredUserTimestamps);

      if (filteredUserTimestamps.length >= this.config.maxTasksPerUserWindow) {
        const retryAfterMs = this.calculateRetryAfterMs(filteredUserTimestamps);
        this.trackRejection("user_rate_limit", task);
        throw new BackpressureError(
          "User rate limit exceeded",
          this.config.maxTasksPerUserWindow,
          this.config.maxTasksPerUserWindow - filteredUserTimestamps.length,
          retryAfterMs,
          {
            taskId: task.id,
            taskName: task.name,
            userId: task.userId,
          },
        );
      }
    }

    // check queue capacity
    if (this.queueSize >= this.config.maxQueuedSize) {
      this.trackRejection("queue_full", task);
      throw new BackpressureError(
        "Queue capacity exceeded",
        this.config.maxQueuedSize,
        this.config.maxQueuedSize - this.queueSize,
        1000, // 1 second retry after
        {
          taskId: task.id,
          taskName: task.name,
        },
      );
    }

    // accept the task
    this.globalTaskTimestamps.push(now);
    this.queueSize++;
    this.acceptedInWindow++;
    this.totalAccepted++;

    if (task.userId) {
      const userTimestamps = this.userTaskTimestamps.get(task.userId) ?? [];
      userTimestamps.push(now);
      this.userTaskTimestamps.set(task.userId, userTimestamps);
    }
  }

  /**
   * Decrement queue size when a task acquires an execution slot
   */
  decrementQueueSize(): void {
    this.queueSize = Math.max(0, this.queueSize - 1);
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queueSize;
  }

  /**
   * Get global window timestamps
   */
  getGlobalWindowSize(): number {
    const windowStart = Date.now() - this.config.windowSizeMs;
    return this.globalTaskTimestamps.filter((ts) => ts >= windowStart).length;
  }

  /**
   * Get user window timestamps
   */
  getUserWindowSize(userId: UserId): number {
    const windowStart = Date.now() - this.config.windowSizeMs;
    const timestamps = this.userTaskTimestamps.get(userId) ?? [];
    return timestamps.filter((ts) => ts >= windowStart).length;
  }

  /**
   * Get admission stats
   */
  getStats(): AdmissionStats {
    const windowStats: WindowStats = {
      accepted: this.acceptedInWindow,
      rejected: this.rejectedInWindow,
      startedAt: this.windowStartedAt,
    };

    return {
      config: this.config,
      window: windowStats,
      rejections: {
        byReason: this.rejectionsByReason,
        lastAt: this.lastRejectionAt,
      },
      totals: {
        accepted: this.totalAccepted,
        rejected: this.totalRejected,
      },
    };
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.globalTaskTimestamps = [];
    this.userTaskTimestamps.clear();
    this.queueSize = 0;
    this.windowStartedAt = Date.now();
    this.acceptedInWindow = 0;
    this.rejectedInWindow = 0;
    this.rejectionsByReason = {
      global_rate_limit: 0,
      user_rate_limit: 0,
      queue_full: 0,
      in_dlq: 0,
    };
    this.lastRejectionAt = undefined;
    this.totalAccepted = 0;
    this.totalRejected = 0;
  }

  /**
   * Track a rejection and emit metrics
   */
  private trackRejection(reason: RejectionReason, task: Task): void {
    this.rejectedInWindow++;
    this.totalRejected++;
    this.rejectionsByReason[reason]++;
    this.lastRejectionAt = Date.now();

    this.hooks.incrementCounter(TaskMetrics.GUARD_REJECTIONS, 1, {
      [TaskAttributes.TASK_NAME]: task.name,
      reason,
    });
  }

  /**
   * Calculate when the client should retry based on oldest timestamp in window
   */
  private calculateRetryAfterMs(timestamps: number[]): number {
    if (timestamps.length === 0) return 0;

    const oldestTimestamp = Math.min(...timestamps);
    const windowExpiresAt = oldestTimestamp + this.config.windowSizeMs;
    const retryAfterMs = Math.max(0, windowExpiresAt - Date.now());

    return retryAfterMs;
  }
}
