import type { IdempotencyKey, TaskName, UserId } from "@/core/branded";
import { BackpressureError } from "@/core/errors";
import type { Task } from "@/domain";
import { noopHooks, type TaskSystemHooks } from "@/observability";
import { Backpressure } from "./backpressure";
import { DeadLetterQueue } from "./dlq";
import { SlotManager } from "./slot-manager";
import {
  DEFAULT_GUARD_CONFIG,
  type DLQEntry,
  type DLQEventListener,
  type DLQStats,
  type GuardConfig,
  type GuardStats,
  type RecoverySlotStats,
} from "./types";

/**
 * Merge partial config with defaults
 */
function mergeConfig(partial?: Partial<GuardConfig>): GuardConfig {
  const defaults: GuardConfig = DEFAULT_GUARD_CONFIG;

  if (!partial) return defaults;

  return {
    backpressure: {
      ...defaults.backpressure,
      ...partial.backpressure,
    },
    slots: {
      ...defaults.slots,
      ...partial.slots,
    },
    dlq: {
      ...defaults.dlq,
      ...partial.dlq,
    },
    recovery: {
      ...defaults.recovery,
      ...partial.recovery,
    },
  };
}

/**
 * Guard is the main orchestrator for task admission control
 *
 * Combines:
 * - Backpressure: Rate limiting and queue management
 * - SlotManager: Concurrent execution slot management
 * - DeadLetterQueue: Failed task storage and retry
 * - Recovery slots: Separate pool for task recovery operations
 */
export class Guard {
  private readonly config: GuardConfig;
  private readonly hooks: TaskSystemHooks;

  // sub-components
  private readonly backpressure: Backpressure;
  private readonly slotManager: SlotManager;
  private readonly dlq: DeadLetterQueue;

  // recovery slot tracking (simple counter, no waiting queue)
  private recoverySlotsInUse = 0;

  constructor(
    config: Partial<GuardConfig>,
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.config = mergeConfig(config);
    this.hooks = hooks;

    // initialize sub-components with their respective config and hooks
    this.backpressure = new Backpressure(this.config.backpressure, this.hooks);
    this.slotManager = new SlotManager(this.config.slots, this.hooks);
    this.dlq = new DeadLetterQueue(this.config.dlq, this.hooks);
  }

  /**
   * Accept a task for processing
   * Validates raate limits and queue capacity
   * @throws {ValidationError} if task is in DLQ
   * @throws {BackpressureError} if limits exceeded
   */
  acceptTask(task: Task): void {
    this.backpressure.accept(task, this.dlq.has(task.idempotencyKey));
  }

  /**
   * Acquire an execution slot for a task
   * Decrements queue size on success
   * @throws {SlotTimeoutError} if timeout is reached
   */
  async acquireExecutionSlot(task: Task): Promise<void> {
    await this.slotManager.acquire(task);
    this.backpressure.decrementQueueSize();
  }

  /**
   * Release an execution slot
   */
  releaseExecutionSlot(task: Task): void {
    this.slotManager.release(task);
  }

  /**
   * Acquire a recovery slot
   * @throws {BackpressureError} if recovery capacity is exhausted
   */
  acquireRecoverySlot(): void {
    if (this.recoverySlotsInUse >= this.config.recovery.maxRecoverySlots) {
      throw new BackpressureError(
        "Recovery capacity exhausted",
        this.config.recovery.maxRecoverySlots,
      );
    }
    this.recoverySlotsInUse++;
  }

  /**
   * Release a recovery slot
   */
  releaseRecoverySlot(): void {
    this.recoverySlotsInUse = Math.max(0, this.recoverySlotsInUse - 1);
  }

  /**
   * Add a task to dead letter queue
   */
  addToDLQ(task: Task, reason?: string, error?: string): void {
    this.dlq.add(task, reason, error);
  }

  /**
   * Remove a task from dead letter queue
   */
  removeFromDLQ(idempotencyKey: IdempotencyKey): boolean {
    return this.dlq.remove(idempotencyKey);
  }

  /**
   * Check if a task is in the DLQ
   */
  isTaskInDLQ(idempotencyKey: IdempotencyKey): boolean {
    return this.dlq.has(idempotencyKey);
  }

  /**
   * Get a DLQ entry
   */
  getDLQEntry(idempotencyKey: IdempotencyKey): DLQEntry | undefined {
    return this.dlq.get(idempotencyKey);
  }

  /**
   * Get all DLQ entries
   */
  getDLQEntries(): DLQEntry[] {
    return this.dlq.getAll();
  }

  /**
   * Get DLQ size
   */
  getDLQSize(): number {
    return this.dlq.size;
  }

  /**
   * Retry a task from the DLQ
   */
  retryFromDLQ(idempotencyKey: IdempotencyKey): Task | null {
    return this.dlq.retry(idempotencyKey);
  }

  /**
   * Retry all tasks from the DLQ
   */
  retryAllFromDLQ(): Task[] {
    return this.dlq.retryAll();
  }

  /**
   * Retry DLQ entries matching a filter
   */
  retryDLQWithFilter(filter: (entry: DLQEntry) => boolean): Task[] {
    return this.dlq.retryWithFilter(filter);
  }

  /**
   * Subscribe to DLQ events
   */
  onDLQEvent(listener: DLQEventListener): () => void {
    return this.dlq.onEvent(listener);
  }

  /**
   * Get DLQ statistics
   */
  getDLQStats(): DLQStats {
    return this.dlq.getStats();
  }

  /**
   * Get comprehensive guard statistics
   */
  getStats(): GuardStats {
    const recoveryStats: RecoverySlotStats = {
      inUse: this.recoverySlotsInUse,
      limit: this.config.recovery.maxRecoverySlots,
      available: Math.max(
        0,
        this.config.recovery.maxRecoverySlots - this.recoverySlotsInUse,
      ),
    };
    return {
      admission: this.backpressure.getStats(),
      slots: this.slotManager.getStats(),
      dlq: this.dlq.getStats(),
      recovery: recoveryStats,
    };
  }

  /**
   * Get number of tasks waiting for execution slots
   */
  getWaitingQueueSize(): number {
    return this.slotManager.getWaitingQueueSize();
  }

  /**
   * Get global queue size (tasks admitted but not yet executing)
   */
  getGlobalQueueSize(): number {
    return this.backpressure.getQueueSize();
  }

  /**
   * Get global execution size (tasks currently executing)
   */
  getGlobalExecutionSize(): number {
    return this.slotManager.getGlobalExecutionSize();
  }

  /**
   * Get user execution size
   */
  getUserExecutionSize(userId: UserId): number {
    return this.slotManager.getUserExecutionSize(userId);
  }

  /**
   * Get template execution size
   */
  getTemplateExecutionSize(templateName: TaskName): number {
    return this.slotManager.getTemplateExecutionSize(templateName);
  }

  /**
   * Shutdown the guard (clears all state, stop timers)
   */
  shutdown(): void {
    this.dlq.shutdown();
    this.clear();
  }

  /**
   * Clear all state (keep timers running)
   */
  clear(): void {
    this.backpressure.clear();
    this.slotManager.clear();
    this.dlq.clear();
    this.recoverySlotsInUse = 0;
  }
}
