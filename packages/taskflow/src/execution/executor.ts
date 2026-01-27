import type { IdempotencyKey } from "@/core/branded";
import { isRetryableError } from "@/core/errors";
import {
  createTaskEvent,
  isAsyncGenerator,
  type Task,
  type TaskDefinition,
  type TaskEventContext,
  type TaskEventInput,
  type TaskHandlerContext,
} from "@/domain";
import {
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  TaskSpans,
  type TaskSystemHooks,
} from "@/observability";
import type { EventLog } from "@/persistence";
import {
  type ExecutorConfig,
  type ExecutorStats,
  mergeExecutorConfig,
  type TaskEventSubscriber,
} from "./types";

/**
 * Dependencies for TaskExecutor
 */
export interface TaskExecutorDeps {
  /** event log for WAL persistence */
  eventLog: EventLog;
  /** optional event subscribers */
  subscribers?: TaskEventSubscriber;
}

/**
 * TaskExecutor handles the execution of task handlers with:
 * - Retry logic with exponential backoff
 * - Periodic heartbeat emission
 * - AbortController for cancellation
 * - WAL-first event persistence
 */
export class TaskExecutor {
  private readonly config: ExecutorConfig;
  private readonly hooks: TaskSystemHooks;
  private readonly eventLog: EventLog;
  private readonly subscribers?: TaskEventSubscriber;

  /** active abort controllers keyed by idempotency key */
  private readonly abortControllers: Map<IdempotencyKey, AbortController>;
  /** active heartbeat intervals keyed by idempotency key */
  private readonly heartbeatIntervals: Map<
    IdempotencyKey,
    ReturnType<typeof setInterval>
  >;

  /** event sequence numbers per task */
  private readonly eventSeqMap: Map<string, number>;

  /** statistics counters */
  private completedCount = 0;
  private failedCount = 0;
  private cancelledCount = 0;
  private handlerMissingCount = 0;
  private retriesAttemptedCount = 0;
  private retriesSucceededCount = 0;
  private retriesExhaustedCount = 0;
  private lastStartAt: number | null = null;
  private lastCompleteAt: number | null = null;

  constructor(
    config: Partial<ExecutorConfig> | undefined,
    deps: TaskExecutorDeps,
    hooks: TaskSystemHooks = noopHooks,
  ) {
    this.config = mergeExecutorConfig(config);
    this.hooks = hooks;
    this.eventLog = deps.eventLog;
    this.subscribers = deps.subscribers;

    this.abortControllers = new Map();
    this.heartbeatIntervals = new Map();
    this.eventSeqMap = new Map();
  }

  /**
   * Execute a task with the given handler
   */
  async execute(task: Task, definition?: TaskDefinition): Promise<void> {
    const handler = definition?.handler;

    // start the task
    task.start();
    this.lastStartAt = Date.now();

    // create event context for this task
    const context: TaskEventContext = {
      taskId: task.id,
      name: task.name,
      idempotencyKey: task.idempotencyKey,
      userId: task.userId,
      taskType: task.type,
      executionOptions: task.executionOptions,
    };

    // handle missing handler
    if (!handler) {
      task.fail(`Handler for task ${task.name} not found`);
      this.handlerMissingCount++;
      this.failedCount++;
      this.lastCompleteAt = Date.now();

      this.emit(context, {
        type: "error",
        message: `Handler for task ${task.name} not found`,
      });

      this.subscribers?.onComplete?.(task);
      return;
    }

    // emit start event
    this.emit(context, {
      type: "start",
      input: task.input,
      message: `Starting task ${task.name}`,
    });

    // create abort controller for this task
    const controller = new AbortController();
    this.abortControllers.set(task.idempotencyKey, controller);

    // start heartbeat
    const stopHeartbeat = this.startHeartbeat(task, context);

    try {
      await this.hooks.withSpan(
        TaskSpans.TASK_EXECUTE,
        {
          [TaskAttributes.TASK_ID]: task.id,
          [TaskAttributes.TASK_NAME]: task.name,
          [TaskAttributes.TASK_TYPE]: task.type,
        },
        async (span) => {
          try {
            await this.executeWithRetry(
              task,
              definition,
              controller.signal,
              context,
            );
            span.setStatus("ok");
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus("error", (error as Error).message);
            throw error;
          }
        },
      );
    } finally {
      stopHeartbeat();
      this.abortControllers.delete(task.idempotencyKey);
      this.eventSeqMap.delete(task.id);
      this.subscribers?.onComplete?.(task);
    }
  }

  /**
   * Abort a running task by idempotency key
   */
  abort(idempotencyKey: IdempotencyKey): void {
    const controller = this.abortControllers.get(idempotencyKey);
    if (controller) controller.abort("Task aborted");
  }

  /**
   * Abort all running tasks
   */
  abortAll(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort("Task aborted");
    }
    this.abortControllers.clear();

    // clear all heartbeat intervals
    for (const interval of this.heartbeatIntervals.values()) {
      clearInterval(interval);
    }
  }

  /**
   * Check if a task is currently executing
   */
  isExecuting(idempotencyKey: IdempotencyKey): boolean {
    return this.abortControllers.has(idempotencyKey);
  }

  /**
   * Get executor statistics
   */
  getStats(): ExecutorStats {
    const total =
      this.completedCount +
      this.failedCount +
      this.cancelledCount +
      this.handlerMissingCount;

    return {
      current: {
        executing: this.abortControllers.size,
        heartbeatsActive: this.heartbeatIntervals.size,
      },
      outcomes: {
        completed: this.completedCount,
        failed: this.failedCount,
        cancelled: this.cancelledCount,
        handlerMissing: this.handlerMissingCount,
        total,
      },
      retries: {
        attempted: this.retriesAttemptedCount,
        succeeded: this.retriesSucceededCount,
        exhausted: this.retriesExhaustedCount,
      },
      timing: {
        lastStartAt: this.lastStartAt ?? undefined,
        lastCompleteAt: this.lastCompleteAt ?? undefined,
      },
      debug: {
        executingTaskKeys: Array.from(this.abortControllers.keys()),
      },
    };
  }

  /**
   * Execute handler with retry logic
   */

  private async executeWithRetry(
    task: Task,
    definition: TaskDefinition,
    signal: AbortSignal,
    context: TaskEventContext,
  ): Promise<void> {
    const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier } =
      this.config.retry;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isRetryAttempt = attempt > 1;

      if (isRetryAttempt) {
        task.incrementAttempt();
        this.retriesAttemptedCount++;
      }

      // check for abort before each attempt
      if (signal.aborted) {
        task.cancel("Task aborted");
        this.cancelledCount++;
        this.lastCompleteAt = Date.now();

        this.emit(context, {
          type: "cancelled",
          message: "Task cancelled",
        });

        this.hooks.incrementCounter(TaskMetrics.TASKS_CANCELLED, 1, {
          [TaskAttributes.TASK_NAME]: task.name,
        });

        return;
      }

      const handlerResult: TaskEventInput[] = [];

      try {
        // create handler context
        const handlerContext: TaskHandlerContext = {
          taskId: task.id,
          name: task.name,
          userId: task.userId,
          idempotencyKey: task.idempotencyKey,
          attempt,
          signal,
        };

        // execute handler
        const execution = definition.handler(task.input, handlerContext);

        if (isAsyncGenerator(execution)) {
          // handle async generator
          for await (const event of execution) {
            if (signal.aborted) {
              task.cancel("Task aborted");
              this.cancelledCount++;
              this.lastCompleteAt = Date.now();
              throw new Error("Task aborted");
            }

            handlerResult.push(event);
            this.emit(context, event);
          }
        } else {
          // handle promise
          const resultEvent = await execution;
          if (resultEvent) {
            handlerResult.push({ type: "progress", result: resultEvent });
            this.emit(context, { type: "progress", result: resultEvent });
          }
        }

        // task completed successfully
        task.complete(handlerResult);
        this.completedCount++;
        this.lastCompleteAt = Date.now();

        // track successful retries
        if (isRetryAttempt) {
          this.retriesSucceededCount++;
        }

        this.emit(context, {
          type: "complete",
          message: `Task ${task.name} completed`,
          durationMs: task.durationMs,
          result: handlerResult,
        });

        this.hooks.incrementCounter(TaskMetrics.TASKS_COMPLETED, 1, {
          [TaskAttributes.TASK_NAME]: task.name,
        });

        this.hooks.recordHistogram(
          TaskMetrics.TASK_DURATION_MS,
          task.durationMs ?? 0,
          {
            [TaskAttributes.TASK_NAME]: task.name,
          },
        );

        return;
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const isRetryable = isRetryableError(error);
        const isLastAttempt = attempt === maxAttempts;

        if (isLastAttempt || !isRetryable) {
          // track exhausted retries
          if (isLastAttempt && isRetryable) {
            this.retriesExhaustedCount++;
          }

          task.fail(errorMessage);
          this.failedCount++;
          this.lastCompleteAt = Date.now();

          this.emit(context, {
            type: "error",
            message: errorMessage,
            error: errorMessage,
            retryable: isRetryable,
            attempt,
            maxAttempts,
          });

          this.emit(context, {
            type: "complete",
            message: `Task ${task.name} failed after ${attempt} attempts`,
          });

          this.hooks.incrementCounter(TaskMetrics.TASKS_FAILED, 1, {
            [TaskAttributes.TASK_NAME]: task.name,
            [TaskAttributes.ERROR_TYPE]:
              error instanceof Error ? error.name : "UnknownError",
          });

          return;
        }

        // calculate retry delay with exponential backoff
        const delay = Math.min(
          initialDelayMs * backoffMultiplier ** (attempt - 1),
          maxDelayMs,
        );

        this.emit(context, {
          type: "retry",
          message: `Retrying task ${task.name} in ${delay}ms (attempt ${attempt}/${maxAttempts})`,
          attempt,
          maxAttempts,
          nextRetryDelayMs: delay,
        });

        this.hooks.incrementCounter(TaskMetrics.TASKS_RETRIED, 1, {
          [TaskAttributes.TASK_NAME]: task.name,
          [TaskAttributes.TASK_ATTEMPT]: attempt,
        });

        // wait before retry
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Start periodic heartbeat emission
   */
  private startHeartbeat(task: Task, context: TaskEventContext): () => void {
    const interval = setInterval(() => {
      if (task.status !== "running") return;

      task.recordHeartbeat();

      this.emit(context, {
        type: "heartbeat",
        message: "Task heartbeat",
        timestamp: task.lastHeartbeatAt?.getTime() ?? Date.now(),
      });
    }, this.config.heartbeatIntervalMs);

    this.heartbeatIntervals.set(task.idempotencyKey, interval);

    return () => {
      clearInterval(interval);
      this.heartbeatIntervals.delete(task.idempotencyKey);
    };
  }

  /**
   * Emit an event to EventLog and subscribers
   * WAL-first: persist to EventLog before notifying subscribers
   */
  private emit(context: TaskEventContext, input: TaskEventInput): void {
    const seq = (this.eventSeqMap.get(context.taskId) ?? 0) + 1;
    this.eventSeqMap.set(context.taskId, seq);

    // generate event ID if not provided
    const id = input.id ?? this.generateEventId(context.taskId, seq);

    // create full TaskEvent
    const event = createTaskEvent({ ...input, id }, context);

    // persist to EventLog first (WAL-first)
    this.eventLog.appendEvent(event);

    // notify subscribers (StreamManager)
    this.subscribers?.onEvent(context.idempotencyKey, event);
  }

  /**
   * Generate a unique event ID
   */
  private generateEventId(taskId: string, seq: number): string {
    return `${taskId}:${seq}:${Date.now()}`;
  }
}
