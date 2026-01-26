import { type IdempotencyKey, idempotencyKey } from "@/core/branded";
import type { Task } from "@/domain";
import {
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  type TaskSystemHooks,
} from "@/observability";
import type {
  DLQConfig,
  DLQEntry,
  DLQEvent,
  DLQEventListener,
  DLQStats,
  RejectionReason,
} from "./types";

/**
 * Dead Letter Queue for storing failed tasks
 *
 * Features:
 * - Add/remove/retry tasks
 * - TTL-based expiration with automatic cleanup
 * - Max size with FIFO eviction
 * - Event emission for all state changes
 * - Comprehensive statistics
 */
export class DeadLetterQueue {
  private readonly config: DLQConfig;
  private readonly hooks: TaskSystemHooks;

  // entry storage (map preserves insertion order for FIFO eviction)
  private entries: Map<string, DLQEntry> = new Map();

  // event listeners
  private eventListeners: Set<DLQEventListener> = new Set();

  // cleanup timer
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // statistics
  private totalAdded = 0;
  private totalRemoved = 0;
  private totalExpired = 0;
  private totalEvicted = 0;
  private totalRetries = 0;
  private lastEventAt?: number;

  constructor(config: DLQConfig, hooks: TaskSystemHooks = noopHooks) {
    this.config = config;
    this.hooks = hooks;

    this.startCleanupTimer();
  }

  /**
   * Add a task to the DLQ
   */
  add(task: Task, reason?: string, error?: string): void {
    const now = Date.now();

    // evict oldest if at capacity
    if (this.entries.size >= this.config.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) {
        const evictedEntry = this.entries.get(oldestKey);
        this.entries.delete(oldestKey);
        this.totalEvicted++;

        if (evictedEntry) {
          this.emitEvent({
            type: "dlq:evicted",
            idempotencyKey: idempotencyKey(oldestKey),
            taskName: evictedEntry.task.name,
            userId: evictedEntry.task.userId ?? undefined,
            reason: "capacity_exceeded",
            timestamp: now,
          });
        }
      }
    }

    // add the entry
    const entry: DLQEntry = {
      task,
      addedAt: now,
      reason,
      retryCount: 0,
      error,
    };

    this.entries.set(task.idempotencyKey, entry);
    this.totalAdded++;
    this.lastEventAt = now;

    // emit metrics
    this.hooks.incrementCounter(TaskMetrics.DLQ_ADDED, 1, {
      [TaskAttributes.TASK_NAME]: task.name,
      reason: reason ?? "unknown",
    });
    this.emitSizeGauge();

    // emit event
    this.emitEvent({
      type: "dlq:added",
      idempotencyKey: task.idempotencyKey,
      taskName: task.name,
      userId: task.userId ?? undefined,
      reason: reason,
      timestamp: now,
      error,
    });
  }

  /**
   * Remove a task from the DLQ
   */
  remove(idempotencyKey: IdempotencyKey): boolean {
    const entry = this.entries.get(idempotencyKey);
    if (!entry) return false;

    const now = Date.now();
    this.entries.delete(idempotencyKey);
    this.totalRemoved++;
    this.lastEventAt = now;

    this.emitSizeGauge();

    this.emitEvent({
      type: "dlq:removed",
      idempotencyKey,
      taskName: entry.task.name,
      userId: entry.task.userId ?? undefined,
      reason: entry.reason ?? "unknown",
      timestamp: now,
    });

    return true;
  }

  /**
   * Check if a task is in the DLQ
   */
  has(idempotencyKey: IdempotencyKey): boolean {
    return this.entries.has(idempotencyKey);
  }

  /**
   * Get a DLQ entry by idempotency key
   */
  get(idempotencyKey: IdempotencyKey): DLQEntry | undefined {
    return this.entries.get(idempotencyKey);
  }

  /**
   * Get all DLQ entries
   */
  getAll(): DLQEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Current DLQ size
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Retry a task from the DLQ
   * Returns the task if successful, null if max retries exceeded or not found
   */
  retry(idempotencyKey: IdempotencyKey): Task | null {
    const entry = this.entries.get(idempotencyKey);
    if (!entry) return null;

    const now = Date.now();

    // check max retries
    if (entry.retryCount >= this.config.maxRetries) {
      this.lastEventAt = now;

      this.emitEvent({
        type: "dlq:retry_exhausted",
        idempotencyKey,
        taskName: entry.task.name,
        userId: entry.task.userId ?? undefined,
        reason: "max_retries_exceeded",
        timestamp: now,
        retryAttempt: entry.retryCount,
      });

      return null;
    }

    // increment retry count and update last retry timestamp
    entry.retryCount++;
    entry.lastRetryAt = now;
    this.totalRetries++;
    this.lastEventAt = now;

    // remove from DLQ
    this.entries.delete(idempotencyKey);

    // reset task to pending state
    entry.task.resetToPending();

    // emit metrics
    this.hooks.incrementCounter(TaskMetrics.DLQ_RETRIED, 1, {
      [TaskAttributes.TASK_NAME]: entry.task.name,
    });
    this.emitSizeGauge();

    // emit event

    this.emitEvent({
      type: "dlq:retried",
      idempotencyKey,
      taskName: entry.task.name,
      userId: entry.task.userId ?? undefined,
      timestamp: now,
      retryAttempt: entry.retryCount,
    });

    return entry.task;
  }

  /**
   * Retry all tasks in the DLQ
   */
  retryAll(): Task[] {
    const tasks: Task[] = [];
    const keys = Array.from(this.entries.keys());

    for (const key of keys) {
      const task = this.retry(idempotencyKey(key));
      if (task) tasks.push(task);
    }

    return tasks;
  }

  /**
   * Retry tasks matching a filter
   */
  retryWithFilter(filter: (entry: DLQEntry) => boolean): Task[] {
    const tasks: Task[] = [];

    for (const entry of this.entries.values()) {
      if (filter(entry)) {
        const task = this.retry(entry.task.idempotencyKey);
        if (task) tasks.push(task);
      }
    }

    return tasks;
  }

  /**
   * Subscribe to DLQ events
   * Returns unsubscribe function
   */
  onEvent(listener: DLQEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Get DLQ stats
   */
  getStats(): DLQStats {
    const now = Date.now();
    const byReason: Record<RejectionReason, number> = {
      global_rate_limit: 0,
      user_rate_limit: 0,
      queue_full: 0,
      in_dlq: 0,
    };
    let totalAgeMs = 0;
    let oldestAgeMs = 0;

    for (const entry of this.entries.values()) {
      byReason[entry.reason as RejectionReason] =
        (byReason[entry.reason as RejectionReason] ?? 0) + 1;

      const ageMs = now - entry.addedAt;
      totalAgeMs += ageMs;

      if (ageMs > oldestAgeMs) {
        oldestAgeMs = ageMs;
      }
    }

    return {
      size: this.entries.size,
      byReason,
      totalAdded: this.totalAdded,
      totalRemoved: this.totalRemoved,
      totalExpired: this.totalExpired,
      totalEvicted: this.totalEvicted,
      totalRetries: this.totalRetries,
      avgAgeMs: this.entries.size > 0 ? totalAgeMs / this.entries.size : 0,
      oldestAgeMs,
      lastEventAt: this.lastEventAt ?? 0,
    };
  }

  /**
   * Clear all entries and reset stats
   */
  clear(): void {
    this.entries.clear();
    this.totalAdded = 0;
    this.totalRemoved = 0;
    this.totalExpired = 0;
    this.totalEvicted = 0;
    this.totalRetries = 0;
    this.lastEventAt = undefined;

    this.emitSizeGauge();
  }

  /**
   * Shutdown the DLQ (stop cleanup timer, clear entries)
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.entries.clear();
    this.eventListeners.clear();
  }

  /**
   * Start the cleanup timer for TTL expiration
   */
  private startCleanupTimer(): void {
    if (this.config.cleanupIntervalMs <= 0) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.config.cleanupIntervalMs);

    // don't keep the process alive just for cleanup
    this.cleanupTimer.unref();
  }

  /**
   * Remove expired entries based on TTL
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    const expiredKeys: IdempotencyKey[] = [];

    for (const [key, entry] of this.entries.entries()) {
      if (now - entry.addedAt >= this.config.ttlMs) {
        expiredKeys.push(idempotencyKey(key));
      }
    }

    for (const key of expiredKeys) {
      const entry = this.entries.get(key);
      this.entries.delete(key);
      this.totalExpired++;
      this.lastEventAt = now;

      if (entry) {
        this.emitEvent({
          type: "dlq:expired",
          idempotencyKey: key,
          taskName: entry.task.name,
          userId: entry.task.userId ?? undefined,
          reason: entry.reason ?? "unknown",
          timestamp: now,
        });
      }
    }

    if (expiredKeys.length > 0) {
      this.emitSizeGauge();
    }
  }

  /**
   * Emit an event to all listeners
   */
  private emitEvent(event: DLQEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // swallow listener errors
      }
    }
  }

  /**
   * Emit DLQ size gauge
   */
  private emitSizeGauge(): void {
    this.hooks.recordGauge(TaskMetrics.DLQ_SIZE, this.entries.size);
  }
}
