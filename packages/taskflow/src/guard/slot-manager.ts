import type { TaskName, UserId } from "@/core/branded";
import { SlotTimeoutError } from "@/core/errors";
import type { Task } from "@/domain";
import {
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  type TaskSystemHooks,
} from "@/observability";
import type { SlotManagerConfig, SlotStats } from "./types";

/**
 * Waiting request in the slot acquisition queue
 */
interface WaitingRequest {
  task: Task;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * SlotManager controls concurrent execution slots
 *
 * Enforces:
 * - Global execution limit
 * - Per-user execution limit
 * - Per-template execution limit
 * - Timeout for slot acquisition
 *
 */
export class SlotManager {
  private readonly config: SlotManagerConfig;
  private readonly hooks: TaskSystemHooks;

  // execution tracking
  private globalExecutionCount = 0;
  private userExecutionCounts: Map<UserId, number> = new Map();
  private templateExecutionCounts: Map<TaskName, number> = new Map();

  // waiting queue
  private waitingQueue: WaitingRequest[] = [];

  // statistics
  private slotTimeouts = 0;
  private slotsAcquired = 0;
  private slotsReleased = 0;

  constructor(config: SlotManagerConfig, hooks: TaskSystemHooks = noopHooks) {
    this.config = config;
    this.hooks = hooks;
  }

  /**
   * Acquire an execution slot for a task
   * Waits in queue if no slots available, throws on timeout
   */
  async acquire(task: Task): Promise<void> {
    // try immediate acquisition
    if (this.tryAcquire(task)) {
      this.emitGauges();
      return;
    }

    // wait in queue
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // remove from waiting queue
        const index = this.waitingQueue.findIndex(
          (req) => req.task.id === task.id,
        );
        if (index !== -1) {
          this.waitingQueue.splice(index, 1);
        }

        this.slotTimeouts++;
        this.hooks.incrementCounter(TaskMetrics.GUARD_REJECTIONS, 1, {
          [TaskAttributes.TASK_ID]: task.id,
          [TaskAttributes.TASK_NAME]: task.name,
          reason: "slot_timeout",
        });

        reject(
          new SlotTimeoutError(
            "Slot acquisition timeout",
            this.config.slotTimeoutMs,
            {
              taskId: task.id,
              taskName: task.name,
              userId: task.userId ?? undefined,
            },
          ),
        );
      }, this.config.slotTimeoutMs);

      this.waitingQueue.push({
        task,
        resolve: () => {
          this.emitGauges();
          resolve();
        },
        reject,
        timeoutId,
      });
    });
  }

  /**
   * Releases an execution slot
   */
  release(task: Task): void {
    this.globalExecutionCount = Math.max(0, this.globalExecutionCount - 1);
    this.slotsReleased++;

    // decrement user count
    if (task.userId) {
      const userCount = this.userExecutionCounts.get(task.userId) ?? 0;
      this.userExecutionCounts.set(task.userId, Math.max(0, userCount - 1));
    }

    // decrement template count
    const templateCount = this.templateExecutionCounts.get(task.name) ?? 0;
    this.templateExecutionCounts.set(task.name, Math.max(0, templateCount - 1));

    this.emitGauges();

    // process waiting queue
    this.processWaitingQueue();
  }

  /**
   * Get number of tasks waiting for slots
   */
  getWaitingQueueSize(): number {
    return this.waitingQueue.length;
  }

  /**
   * Get global execution size
   */
  getGlobalExecutionSize(): number {
    return this.globalExecutionCount;
  }

  /**
   * Get user execution size
   */
  getUserExecutionSize(userId: UserId): number {
    return this.userExecutionCounts.get(userId) ?? 0;
  }

  /**
   * Get template execution size
   */
  getTemplateExecutionSize(templateName: TaskName): number {
    return this.templateExecutionCounts.get(templateName) ?? 0;
  }

  /**
   * Get slot statistics
   */
  getStats(): SlotStats {
    return {
      current: {
        inUse: this.globalExecutionCount,
        waiting: this.waitingQueue.length,
        available: Math.max(
          0,
          this.config.maxExecutionGlobal - this.globalExecutionCount,
        ),
      },
      limits: {
        global: this.config.maxExecutionGlobal,
        perUser: this.config.maxExecutionPerUser,
      },
      events: {
        timeouts: this.slotTimeouts,
        acquired: this.slotsAcquired,
        released: this.slotsReleased,
      },
    };
  }

  /**
   * Clear all state
   */
  clear(): void {
    // clear waiting queue timeouts
    for (const request of this.waitingQueue) {
      clearTimeout(request.timeoutId);
    }

    this.globalExecutionCount = 0;
    this.userExecutionCounts.clear();
    this.templateExecutionCounts.clear();
    this.waitingQueue = [];
    this.slotTimeouts = 0;
    this.slotsAcquired = 0;
    this.slotsReleased = 0;
  }

  /**
   * Try to acquire a slot immediately
   * Returns true if successful, false if blocked
   */
  private tryAcquire(task: Task): boolean {
    // check global limit
    if (this.globalExecutionCount >= this.config.maxExecutionGlobal) {
      return false;
    }

    // check user limit
    if (task.userId) {
      const userCount = this.userExecutionCounts.get(task.userId) ?? 0;
      if (userCount >= this.config.maxExecutionPerUser) {
        return false;
      }
    }

    // check template limit
    const templateLimit = task.executionOptions?.maxConcurrentExecutions;
    if (templateLimit) {
      const templateCount = this.templateExecutionCounts.get(task.name) ?? 0;
      if (templateCount >= templateLimit) {
        return false;
      }
    }

    // acquire the slot
    this.globalExecutionCount++;
    this.slotsAcquired++;

    if (task.userId) {
      const userCount = this.userExecutionCounts.get(task.userId) ?? 0;
      this.userExecutionCounts.set(task.userId, userCount + 1);
    }

    const templateCount = this.templateExecutionCounts.get(task.name) ?? 0;
    this.templateExecutionCounts.set(task.name, templateCount + 1);

    return true;
  }

  /**
   * Process waiting queue after a slot is released
   */
  private processWaitingQueue(): void {
    for (let i = 0; i < this.waitingQueue.length; i++) {
      const request = this.waitingQueue[i];

      if (this.tryAcquire(request.task)) {
        // remove from queue
        this.waitingQueue.splice(i, 1);

        // clear timeout
        clearTimeout(request.timeoutId);

        // resolve the promise
        request.resolve();

        // only process one at a time
        return;
      }
    }
  }

  /**
   * Emit gauges metrics for slot usage
   */
  private emitGauges(): void {
    this.hooks.recordGauge(
      TaskMetrics.SLOTS_AVAILABLE,
      this.getStats().current.available,
    );
    this.hooks.recordGauge(
      TaskMetrics.TASKS_RUNNING,
      this.globalExecutionCount,
    );

    this.hooks.recordGauge(TaskMetrics.TASKS_QUEUED, this.waitingQueue.length);
  }
}
