import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { ZodType } from "zod";
import {
  eventId,
  type IdempotencyKey,
  idempotencyKey,
  taskName,
  userId,
} from "@/core/branded";
import { TaskSystemError, ValidationError } from "@/core/errors";
import { StreamManager } from "@/delivery/stream";
import type { StreamConfig } from "@/delivery/types";
import {
  Task,
  type TaskCreationParams,
  type TaskDefinition,
  type TaskEvent,
} from "@/domain";
import { Flush, type FlushConfig, type FlushManagerConfig } from "@/flush";
import { Guard } from "@/guard/guard";
import type { GuardConfig } from "@/guard/types";
import { validateInputSchema } from "@/guard/validator";
import { noopHooks, type TaskSystemHooks } from "@/observability";
import {
  createRepository,
  EventLog,
  type EventLogConfig,
  type RepositoryConfig,
} from "@/persistence";
import { TaskExecutor } from "./executor";
import { TaskRecovery } from "./recovery";
import {
  type ExecutorConfig,
  mergeShutdownConfig,
  type RecoveryConfig,
  type ShutdownConfig,
  type ShutdownOptions,
  type TaskRecoveryParams,
  type TaskRunParams,
  type TaskStreamOptions,
  type TaskSystemStats,
  type TaskSystemStatus,
  type TaskTemplate,
} from "./types";

/**
 * Configuration for the TaskSystem
 */
export interface TaskSystemConfig {
  /** event log configuration */
  eventLog?: Partial<EventLogConfig>;
  /** guard configuration */
  guard?: Partial<GuardConfig>;
  /** stream manager configuration */
  stream?: Partial<StreamConfig>;
  /** flush configuration */
  flush?: Partial<FlushConfig>;
  /** executor configuration */
  executor?: Partial<ExecutorConfig>;
  /** recovery configuration */
  recovery?: Partial<RecoveryConfig>;
  /** repository configuration */
  repository?: RepositoryConfig;
  /** shutdown configuration */
  shutdown?: Partial<ShutdownConfig>;
}

/**
 * TaskSystem is the main orchestrator that coordinates all components:
 * - Guard: Admission control, rate limiting, slot management
 * - EventLog: Write-ahead log for durability
 * - StreamManager: Event streaming to clients
 * - Flush: Background persistence to repository
 * - Executor: Task execution with retry and heartbeat
 * - Recovery: Stale task recovery
 */
export class TaskSystem {
  private readonly config: TaskSystemConfig;
  private readonly shutdownConfig: ShutdownConfig;
  private readonly hooks: TaskSystemHooks;

  // state
  private _isShuttingDown = false;
  private _isInitialized = false;
  private startedAt: number | null = null;

  // registries
  private readonly templates: Map<string, TaskTemplate> = new Map();
  private readonly definitions: Map<string, TaskDefinition> = new Map();

  // queues
  private readonly pendingQueue: Map<IdempotencyKey, Task> = new Map();
  private readonly runningTasks: Map<IdempotencyKey, Task> = new Map();

  // executor tick
  private executorInterval: ReturnType<typeof setInterval> | null = null;
  private isExecutorTickRunning = false;

  // components
  private readonly eventLog: EventLog;
  private readonly flush: Flush;
  private readonly guard: Guard;
  private readonly streamManager: StreamManager;
  private readonly executor: TaskExecutor;
  private recovery!: TaskRecovery;

  constructor(config?: TaskSystemConfig, hooks: TaskSystemHooks = noopHooks) {
    this.config = config ?? {};
    this.shutdownConfig = mergeShutdownConfig(config?.shutdown);
    this.hooks = hooks;

    // initialize components
    this.eventLog = new EventLog(this.config.eventLog ?? {}, hooks);
    this.flush = new Flush(
      {
        ...this.config.flush,
        repository: this.config.repository ?? {
          type: "sqlite",
          database: "./.taskflow/sqlite.db",
        },
      } as FlushManagerConfig,
      hooks,
    );

    this.guard = new Guard(this.config.guard ?? {}, hooks);
    this.streamManager = new StreamManager(this.config.stream ?? {}, hooks);
    this.executor = new TaskExecutor(
      this.config.executor,
      {
        eventLog: this.eventLog,
        subscribers: {
          onEvent: (key, event) => this.streamManager.push(key, event),
          onComplete: (task) => this.completeTask(task),
        },
      },
      hooks,
    );
  }

  /**
   * Initialize the task system
   */
  async initialize(): Promise<void> {
    await this.eventLog.initialize();
    await this.flush.initialize();

    // create repository for recovery (async)
    const repository = await createRepository(
      this.config.repository ?? {
        type: "sqlite",
        database: "./.taskflow/sqlite.db",
      },
      this.hooks,
    );

    this.recovery = new TaskRecovery(
      this.config.recovery,
      {
        guard: this.guard,
        repository,
        streamManager: this.streamManager,
        executor: this.executor,
        getDefinition: (name) => this.definitions.get(name),
      },
      this.hooks,
    );

    this.startExecutorTick();
    this.recovery.startBackgroundRecovery();

    this._isInitialized = true;
    this.startedAt = Date.now();

    this.hooks.log({
      severity: "info",
      message: "TaskSystem initialized",
    });
  }

  /**
   * Register a task definition
   */
  registerTask<TInput = unknown, TResult = unknown>(
    definition: TaskDefinition<TInput, TResult>,
  ): TaskTemplate {
    if (this.templates.has(definition.name)) {
      throw new ValidationError(
        `Task ${definition.name} already registered`,
        "name",
      );
    }

    this.definitions.set(definition.name, definition as TaskDefinition);

    const template: TaskTemplate = {
      name: definition.name,
      run: async (params: TaskRunParams) => {
        return this.runTask(definition as TaskDefinition, params);
      },
      recover: async (params: TaskRecoveryParams) => {
        return this.recoverTask(definition as TaskDefinition, params);
      },
    };

    this.templates.set(definition.name, template);
    return template;
  }

  /**
   * Get a registered template
   */
  getTemplate(name: string): TaskTemplate | null {
    return this.templates.get(name) ?? null;
  }

  /**
   * Check if a task is currently running
   */
  getTaskRunning(idempotencyKey: IdempotencyKey): boolean {
    return this.runningTasks.has(idempotencyKey);
  }

  /**
   * Gracefully shutdown the task system
   */
  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    const { deleteFiles = false, force = false } = options;

    if (this._isShuttingDown) return;
    this._isShuttingDown = true;

    // stop accepting new tasks
    this.recovery.stopBackgroundRecovery();

    if (this.executorInterval) {
      clearInterval(this.executorInterval);
      this.executorInterval = null;
    }
    // clear pending queue
    this.pendingQueue.clear();

    // wait for running tasks (unless force)
    if (!force && this.runningTasks.size > 0) {
      const { gracePeriodMs, pollIntervalMs } = this.shutdownConfig;
      const startTime = Date.now();

      while (this.runningTasks.size > 0) {
        const elapsed = Date.now() - startTime;

        if (elapsed >= gracePeriodMs) {
          this.hooks.log({
            severity: "warn",
            message: `Graceful shutdown timed out after ${gracePeriodMs}ms, ${this.runningTasks.size} tasks still running. Forcing abort.`,
          });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    // force abort all running tasks
    this.executor.abortAll();

    // close all streams
    for (const task of this.runningTasks.values()) {
      this.streamManager.close(task.idempotencyKey);
    }

    this.runningTasks.clear();
    this.streamManager.clearAll();

    // shutdown persistence layer
    await this.flush.shutdown();
    await this.eventLog.close(deleteFiles);

    this.guard.shutdown();

    this.hooks.log({
      severity: "info",
      message: "TaskSystem shutdown complete",
    });
  }

  /**
   * Whether the system is shutting down
   */
  get shuttingDown(): boolean {
    return this._isShuttingDown;
  }

  /**
   * Get comprehensive system statistics
   */
  getStats(): TaskSystemStats {
    const guardStats = this.guard.getStats();
    const executorStats = this.executor.getStats();

    const queued = this.pendingQueue.size;
    const waiting = guardStats.slots.current.waiting;
    const executing = executorStats.current.executing;
    const inDLQ = guardStats.dlq.size;

    const { completed, failed, cancelled } = executorStats.outcomes;
    const totalTerminal = completed + failed;
    const successRate =
      totalTerminal > 0 ? completed / totalTerminal : undefined;

    // determine system status
    let status: TaskSystemStatus = "stopped";
    if (this._isShuttingDown) {
      status = "shutting_down";
    } else if (this._isInitialized) {
      // check for degraded state
      const isDegraded =
        guardStats.dlq.size > 0 ||
        (executorStats.retries.exhausted > 0 &&
          executorStats.retries.exhausted > executorStats.retries.succeeded);

      status = isDegraded ? "degraded" : "running";
    } else if (this.startedAt === null) {
      status = "stopped";
    } else {
      status = "starting";
    }

    return {
      system: {
        status,
        startedAt: this.startedAt ?? undefined,
        uptimeMs: this.startedAt ? Date.now() - this.startedAt : undefined,
      },
      tasks: {
        queued,
        waiting,
        executing,
        inDLQ,
        inFlight: queued + waiting + executing,
        totalCompleted: completed,
        totalFailed: failed,
        totalCancelled: cancelled,
        successRate,
      },
      scheduler: {
        tickIntervalMs: 100,
        isTickActive: this.isExecutorTickRunning,
      },
      registry: {
        templates: this.templates.size,
        handlers: this.definitions.size,
      },
      components: {
        guard: guardStats,
        executor: executorStats,
        stream: this.streamManager.getStats(),
        eventLog: this.eventLog.getStats(),
        flush: this.flush.getStats(),
        recovery: this.recovery.getStats(),
      },
    };
  }

  /**
   * Run a task
   */
  private async runTask(
    definition: TaskDefinition,
    params: TaskRunParams,
  ): Promise<Task> {
    // check if shutting down
    if (this._isShuttingDown) {
      throw new TaskSystemError("Task system is shutting down", undefined, {
        taskName: definition.name,
      });
    }

    // validate input schema if provided
    let validatedInput = params.input;
    if (definition.inputSchema) {
      validatedInput = validateInputSchema(
        params.input,
        definition.inputSchema as ZodType,
      );
    }

    // generate idempotency key
    const taskIdempotencyKey = params.idempotencyKey
      ? idempotencyKey(params.idempotencyKey)
      : this.generateIdempotencyKey(definition, params);

    // check for existing running task (deduplication)
    const existingTask = this.runningTasks.get(taskIdempotencyKey);
    if (existingTask) {
      this.streamManager.getOrCreate(taskIdempotencyKey);
      return this.attachStream(existingTask, taskIdempotencyKey);
    }

    // check pending queue
    const pendingTask = this.pendingQueue.get(taskIdempotencyKey);
    if (pendingTask) {
      this.streamManager.getOrCreate(taskIdempotencyKey);
      return this.attachStream(pendingTask, taskIdempotencyKey);
    }

    // check database for recovery - client-side retry
    if (params.idempotencyKey) {
      this.streamManager.getOrCreate(taskIdempotencyKey);
      const generator = this.recovery.handleDatabaseCheck(
        taskIdempotencyKey,
        params.userId,
      );
      let recoveredTask: Task | null = null;
      let iteratorResult = await generator.next();

      while (!iteratorResult.done) {
        this.streamManager.push(taskIdempotencyKey, iteratorResult.value);
        iteratorResult = await generator.next();
      }

      recoveredTask = iteratorResult.value;
      if (recoveredTask)
        return this.attachStream(recoveredTask, taskIdempotencyKey);
    }

    // create new task
    const taskParams: TaskCreationParams = {
      name: taskName(definition.name),
      input: validatedInput,
      userId: userId(params.userId),
      type: definition.type ?? "user",
      executionOptions: definition.defaultOptions,
      idempotencyKey: idempotencyKey(taskIdempotencyKey),
    };

    const task = new Task(taskParams);

    // validate through guard (rate limiting, etc.)
    this.guard.acceptTask(task);

    // create stream and emit created event
    this.streamManager.getOrCreate(taskIdempotencyKey);

    const createdEvent: TaskEvent = {
      id: eventId(
        `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      ),
      type: "created",
      taskId: task.id,
      name: taskName(definition.name),
      idempotencyKey: idempotencyKey(taskIdempotencyKey),
      userId: task.userId ? userId(task.userId) : null,
      input: validatedInput,
      taskType: task.type,
      executionOptions: task.executionOptions,
      timestamp: Date.now(),
    };

    this.streamManager.push(taskIdempotencyKey, createdEvent);

    // add to pending queue
    this.pendingQueue.set(task.idempotencyKey, task);

    return this.attachStream(task, taskIdempotencyKey);
  }

  /**
   * Recover a task from database
   */
  private async recoverTask(
    _definition: TaskDefinition,
    params: TaskRecoveryParams,
  ): Promise<Task | null> {
    const { idempotencyKey: key, userId: uid } = params;
    const idemKey = idempotencyKey(key);

    // create stream and check for existing task
    this.streamManager.getOrCreate(idemKey);

    // check for existing task in database
    const generator = this.recovery.handleDatabaseCheck(idemKey, uid);
    let recoveredTask: Task | null = null;
    let iteratorResult = await generator.next();

    while (!iteratorResult.done) {
      this.streamManager.push(idemKey, iteratorResult.value);
      iteratorResult = await generator.next();
    }

    recoveredTask = iteratorResult.value;

    if (recoveredTask) return this.attachStream(recoveredTask, idemKey);
    return null;
  }

  /**
   * Attach a stream method to task
   */
  private attachStream(task: Task, key: IdempotencyKey): Task {
    // add a stream method to task
    (
      task as Task & {
        stream: (
          options?: TaskStreamOptions,
        ) => AsyncGenerator<TaskEvent, void, unknown>;
      }
    ).stream = (options?: TaskStreamOptions) =>
      this.streamManager.createGenerator(key, options);
    return task;
  }

  /**
   * Start executor tick interval
   */
  private startExecutorTick(): void {
    this.executorInterval = setInterval(async () => {
      if (this.isExecutorTickRunning) return;

      this.isExecutorTickRunning = true;

      try {
        // get first task from queue
        const task = this.pendingQueue.values().next().value as
          | Task
          | undefined;
        if (!task) return;

        // remove from pending queue
        this.pendingQueue.delete(task.idempotencyKey);

        // skip if already running (race condition)
        if (this.runningTasks.has(task.idempotencyKey)) return;

        // acquire execution slot
        try {
          await this.guard.acquireExecutionSlot(task);
        } catch (error) {
          this.guard.addToDLQ(task, "Slot acquisition failed", String(error));
          return;
        }

        // add to running tasks
        this.runningTasks.set(task.idempotencyKey, task);
        this.streamManager.getOrCreate(task.idempotencyKey);

        // execute task
        const definition = this.definitions.get(task.name);
        await this.executor.execute(task, definition);
      } finally {
        this.isExecutorTickRunning = false;
      }
    }, 100);
  }

  /**
   * Handle task completion
   */
  private completeTask(task: Task): void {
    this.guard.releaseExecutionSlot(task);
    this.runningTasks.delete(task.idempotencyKey);
    this.streamManager.close(task.idempotencyKey);
  }

  /**
   * Generate idempotency key from task params
   */
  private generateIdempotencyKey(
    definition: TaskDefinition,
    params: TaskRunParams,
  ): IdempotencyKey {
    const payload = {
      name: definition.name,
      input: params.input,
      userId: params.userId,
    };
    return idempotencyKey(
      createHash("sha256").update(canonicalize(payload)).digest("hex"),
    );
  }
}
