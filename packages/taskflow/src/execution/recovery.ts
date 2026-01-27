import { eventId, type IdempotencyKey } from "@/core/branded";
import { NotFoundError } from "@/core/errors";
import type { StreamManager } from "@/delivery/stream";
import {
  createTaskEvent,
  isAsyncGenerator,
  type RecoveryContext,
  type Task,
  type TaskDefinition,
  type TaskEvent,
  type TaskEventContext,
  type TaskEventInput,
  type TaskHandlerContext,
  toTaskEventType,
} from "@/domain";
import type { Guard } from "@/guard/guard";
import {
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  type TaskSystemHooks,
} from "@/observability";
import type { StoredEvent, TaskRepository } from "@/persistence";
import type { TaskExecutor } from "./executor";
import {
  mergeRecoveryConfig,
  type RecoveryConfig,
  type RecoveryStats,
} from "./types";

/**
 * Dependencies for TaskRecovery
 */
export interface TaskRecoveryDeps {
  /** guard for slot management */
  guard: Guard;
  /** task repository for database access */
  repository: TaskRepository;
  /** stream manager for event delivery */
  streamManager: StreamManager;
  /** executor for re-execution */
  executor: TaskExecutor;
  /** function to get task definition by name */
  getDefinition: (taskName: string) => TaskDefinition | undefined;
}

/**
 * TaskRecovery - Recover stale tasks
 * - Background polling for stale tasks
 * - Smart recovery using recovery handlers
 * - Re-execution fallback
 * - Database reconnection for clients
 */
export class TaskRecovery {
  private readonly config: RecoveryConfig;
  private readonly hooks: TaskSystemHooks;
  private readonly deps: TaskRecoveryDeps;

  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private isRecovering = false;

  // outcome counters
  private backgroundTasksRecovered = 0;
  private userTasksRecovered = 0;
  private tasksFailed = 0;
  private smartRecoveryCount = 0;
  private reexecuteCount = 0;

  // timing
  private lastBackgroundScanAt: number | null = null;
  private lastScanDurationMs: number | null = null;
  private lastScanErrorAt: number | null = null;

  constructor(
    config: Partial<RecoveryConfig> | undefined,
    deps: TaskRecoveryDeps,
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.config = mergeRecoveryConfig(config);
    this.deps = deps;
    this.hooks = hooks;
  }

  /**
   * Start background recovery polling
   */
  startBackgroundRecovery(): void {
    if (!this.config.enabled || this.backgroundTimer) return;

    this.backgroundTimer = setInterval(async () => {
      await this.recoverBackgroundTasks();
    }, this.config.backgroundPollIntervalMs);

    // don't keep process alive just for recovery
    this.backgroundTimer.unref();
  }

  /**
   * Stop background recovery polling
   */
  stopBackgroundRecovery(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  /**
   * Recover stale background tasks
   */
  async recoverBackgroundTasks(): Promise<void> {
    if (!this.config.enabled || this.isRecovering) return;

    this.isRecovering = true;
    const scanStartTime = Date.now();
    this.lastBackgroundScanAt = scanStartTime;

    try {
      const staleTasks = await this.deps.repository.findStaleTasks(
        this.config.staleThresholdMs,
      );

      // only recover background tasks
      const backgroundTasks = staleTasks.filter(
        (task) => task.type === "background",
      );

      for (const task of backgroundTasks.slice(0, this.config.batchSize)) {
        try {
          this.deps.guard.acquireRecoverySlot();

          try {
            for await (const event of this.recoverStaleTask(task)) {
              this.deps.streamManager.push(task.idempotencyKey, event);
            }
            this.backgroundTasksRecovered++;

            this.hooks.incrementCounter(TaskMetrics.TASKS_RECOVERED, 1, {
              [TaskAttributes.TASK_TYPE]: "background",
            });
          } finally {
            this.deps.guard.releaseRecoverySlot();
          }
        } catch (error) {
          this.tasksFailed++;
          this.hooks.log({
            severity: "error",
            message: `Failed to recover background task ${task.id}`,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }

      this.lastScanDurationMs = Date.now() - scanStartTime;
    } catch (error) {
      this.lastScanErrorAt = Date.now();
      this.lastScanDurationMs = Date.now() - scanStartTime;

      this.hooks.log({
        severity: "error",
        message: "Background recovery scan failed",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Recover a user task (via reconnection)
   */
  async *recoverUserTask(task: Task): AsyncGenerator<TaskEvent, void, unknown> {
    try {
      for await (const event of this.recoverStaleTask(task)) {
        yield event;
      }
      this.userTasksRecovered++;

      this.hooks.incrementCounter(TaskMetrics.TASKS_RECOVERED, 1, {
        [TaskAttributes.TASK_TYPE]: "user",
      });
    } catch (error) {
      this.tasksFailed++;
      throw error;
    }
  }

  /**
   * Recover a stale task using smart recovery or re-execution
   */
  async *recoverStaleTask(
    task: Task,
  ): AsyncGenerator<TaskEvent, void, unknown> {
    const definition = this.deps.getDefinition(task.name);

    if (!definition) {
      throw new NotFoundError(
        `Handler for task ${task.name} not found`,
        "handler",
        { taskId: task.id, templateName: task.name },
      );
    }

    // stream previous events from database
    const previousEvents: TaskEvent[] = [];
    for await (const event of this.streamFromDB(task)) {
      previousEvents.push(event);
      yield event;
    }

    // create event context
    const context: TaskEventContext = {
      taskId: task.id,
      name: task.name,
      idempotencyKey: task.idempotencyKey,
      userId: task.userId,
      taskType: task.type,
      executionOptions: task.executionOptions,
    };

    // determine recovery method
    const hasRecoverHandler = !!definition.recover;
    let result:
      | AsyncGenerator<TaskEventInput, unknown, unknown>
      | Promise<unknown>;

    if (hasRecoverHandler && definition.recover) {
      // smart recovery with previous events
      this.smartRecoveryCount++;

      const recoveryContext: RecoveryContext = {
        taskId: task.id,
        name: task.name,
        userId: task.userId,
        idempotencyKey: task.idempotencyKey,
        attempt: task.attempt,
        signal: new AbortController().signal,
        previousEvents,
        recoveryReason: "stale",
        timeSinceLastEventMs: this.getTimeSinceLastEvent(previousEvents),
      };

      result = definition.recover(task.input, recoveryContext);
    } else {
      // re-execute the handler
      this.reexecuteCount++;
      const handlerContext: TaskHandlerContext = {
        taskId: task.id,
        name: task.name,
        userId: task.userId,
        idempotencyKey: task.idempotencyKey,
        attempt: task.attempt + 1,
        signal: new AbortController().signal,
      };

      result = definition.handler(task.input, handlerContext);
    }

    // yield events from recovery/re-execution
    if (isAsyncGenerator(result)) {
      for await (const event of result) {
        yield this.enrichEvent(event, context);
      }
    } else {
      const value = await result;
      if (value) {
        yield this.enrichEvent({ type: "complete", result: value }, context);
      }
    }
  }

  /**
   * Handle database check for reconnecting clients
   *
   * Returns the task if found and authorized, null otherwise
   * yields events from db or recovery as appropriate
   */
  async *handleDatabaseCheck(
    idempotencyKey: IdempotencyKey,
    requestingUserId: string | null,
  ): AsyncGenerator<TaskEvent, Task | null, unknown> {
    // check if repository is initialized
    if (!this.deps.repository.isInitialized) return null;

    // find task by idempotency key
    const task =
      await this.deps.repository.findByIdempotencyKey(idempotencyKey);
    if (!task) return null;

    // verify requesting user owns the task (null userId means background task)
    if (task.userId !== requestingUserId) return null;

    // handle based on task status
    if (task.status === "completed" || task.status === "failed") {
      // stream stored events from db
      yield* this.streamFromDB(task);
      return task;
    }

    if (task.status === "running") {
      if (this.isTaskAlive(task)) {
        // task is still running, wait for completion
        yield* this.waitForTaskCompletion(task);
      } else {
        // task is stale, recover it
        yield* this.recoverUserTask(task);
      }

      // fetch updated task status
      const updatedTask = await this.deps.repository.findById(task.id);
      return updatedTask ?? task;
    }

    return null;
  }

  /**
   *  Get recovery statistics
   */
  getStats(): RecoveryStats {
    return {
      config: {
        enabled: this.config.enabled,
        pollIntervalMs: this.config.backgroundPollIntervalMs,
        staleThresholdMs: this.config.staleThresholdMs,
        batchSize: this.config.batchSize,
      },
      background: {
        isScanning: this.isRecovering,
        lastScanAt: this.lastBackgroundScanAt ?? undefined,
        lastScanDurationMs: this.lastScanDurationMs ?? undefined,
        lastErrorAt: this.lastScanErrorAt ?? undefined,
      },
      outcomes: {
        background: this.backgroundTasksRecovered,
        user: this.userTasksRecovered,
        failed: this.tasksFailed,
        byMethod: {
          smartRecovery: this.smartRecoveryCount,
          reexecution: this.reexecuteCount,
        },
      },
    };
  }

  /**
   * Check if a task is still alive on heartbeat
   */
  private isTaskAlive(task: Task): boolean {
    if (!task.lastHeartbeatAt) return false;
    const age = Date.now() - task.lastHeartbeatAt.getTime();
    return age < this.config.staleThresholdMs;
  }

  /**
   * Wait for a running task to complete
   */
  private async *waitForTaskCompletion(
    task: Task,
  ): AsyncGenerator<TaskEvent, void, unknown> {
    const pollIntervalMs = 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < this.config.completionTimeoutMs) {
      const updatedTask = await this.deps.repository.findById(task.id);

      if (
        updatedTask?.status === "completed" ||
        updatedTask?.status === "failed"
      ) {
        yield* this.streamFromDB(updatedTask);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Stream events from database
   */
  private async *streamFromDB(
    task: Task,
  ): AsyncGenerator<TaskEvent, void, unknown> {
    const events = await this.deps.repository.getEvents(task.id);

    for (const entry of events) {
      const event = this.storedEventToTaskEvent(entry, task);
      if (event) yield event;
    }
  }

  /**
   * Convert stored event to TaskEvent
   */
  private storedEventToTaskEvent(
    entry: StoredEvent,
    task: Task,
  ): TaskEvent | null {
    // skip TASK_CREATED events (already known to client)
    if (entry.type === "TASK_CREATED") return null;

    // map event type from db format (TASK_PROGRESS) to stream format (progress)
    const eventType = toTaskEventType(entry.type);

    return {
      id: eventId(entry.id),
      taskId: task.id,
      name: task.name,
      idempotencyKey: task.idempotencyKey,
      userId: task.userId,
      taskType: task.type,
      type: eventType,
      message: entry.payload?.message as string | undefined,
      result: entry.payload?.result,
      error: entry.payload?.error as string | undefined,
      payload: entry.payload ?? undefined,
      timestamp: entry.timestamp.getTime(),
    };
  }

  /**
   * Enrich event input with task context
   */
  private enrichEvent(event: TaskEventInput, context: TaskEventContext) {
    return createTaskEvent(event, context);
  }

  /**
   * Calculate time since last event
   */
  private getTimeSinceLastEvent(events: TaskEvent[]): number {
    if (events.length === 0) return 0;

    const lastEvent = events[events.length - 1];
    return Date.now() - (lastEvent.timestamp ?? Date.now());
  }
}
