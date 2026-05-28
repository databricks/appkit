/**
 * TaskManager — durable execution core service.
 *
 * Wraps the vendored TaskFlow Node.js bindings (Rust + napi). Only booted
 * when `createApp` receives `task: true` or an explicit task config. When
 * enabled without custom config, default storage is SQLite at
 * `.appkit/tasks/tasks.db`.
 */

import type {
  ResumeOptions,
  StopOptions,
  StreamEvent,
  SubmitOptions,
  Task,
  Engine as TaskflowEngine,
  TaskHandle,
} from "../../vendor/taskflow/taskflow.js";
import { createLogger } from "../logging/logger";
import {
  type Counter,
  SpanStatusCode,
  TelemetryManager,
  type TelemetryProvider,
} from "../telemetry";
import { mergeTaskDefaults, type TaskOption } from "./defaults";
import { loadVendorModule } from "./vendor-loader";

const logger = createLogger("tasks");

interface TaskCounters {
  starts: Counter;
  reconnects: Counter;
  resumes: Counter;
  stops: Counter;
  subscriptions: Counter;
}

/** Single instance per AppKit app when tasks are explicitly enabled. */
export class TaskManager {
  private static _instance: TaskManager | null = null;

  /**
   * Raw vendor engine. Escape hatch for advanced callers (e.g. registering
   * a task definition). Pass-through methods on this manager add tracing
   * and metrics; direct engine calls skip both.
   */
  readonly engine: TaskflowEngine;

  private readonly telemetry: TelemetryProvider;
  private readonly metrics: TaskCounters;
  private hasShutdown = false;

  private constructor(engine: TaskflowEngine) {
    this.engine = engine;
    this.telemetry = TelemetryManager.getProvider("tasks");
    const meter = this.telemetry.getMeter();
    this.metrics = {
      starts: meter.createCounter("tasks.starts", {
        description: "Tasks submitted via TaskManager.start",
        unit: "1",
      }),
      reconnects: meter.createCounter("tasks.reconnects", {
        description: "Reconnect lookups (labelled by found|notfound)",
        unit: "1",
      }),
      resumes: meter.createCounter("tasks.resumes", {
        description: "Resume attempts (labelled by found|notfound)",
        unit: "1",
      }),
      stops: meter.createCounter("tasks.stops", {
        description: "Stop calls (always counted; idempotent)",
        unit: "1",
      }),
      subscriptions: meter.createCounter("tasks.subscriptions", {
        description: "Stream subscriptions opened via TaskManager.subscribe",
        unit: "1",
      }),
    };
  }

  /**
   * Bootstraps the service. Tasks are opt-in: pass `true` or a config object
   * to enable. `undefined` and `false` both return `null`.
   * Idempotent: subsequent calls return the existing instance.
   */
  static async initialize(config: TaskOption): Promise<TaskManager | null> {
    if (config === undefined || config === false) {
      logger.debug("Tasks disabled. Enable with createApp({ task: true }).");
      TaskManager._instance = null;
      return null;
    }
    if (TaskManager._instance) return TaskManager._instance;

    const merged = mergeTaskDefaults(config);
    logger.debug("Initializing task engine", { config: merged });
    warnOnEphemeralStorage(merged);
    const vendor = await loadVendorModule();
    const engine = await vendor.Engine.create(merged);
    const service = new TaskManager(engine);
    TaskManager._instance = service;
    return service;
  }

  /** Bootstraps the service. Returns `null` unless explicitly enabled. */
  static async boot(
    config: TaskOption,
  ): Promise<{ instance: TaskManager; stop(): Promise<void> } | null> {
    const service = await TaskManager.initialize(config);
    if (!service) return null;
    return { instance: service, stop: () => service.shutdown() };
  }

  /** Returns the live instance or `null` when tasks are not enabled. */
  static getInstanceSync(): TaskManager | null {
    return TaskManager._instance;
  }

  /**
   * Spawns a new task attempt. Returns a handle even when a task with the
   * same idempotency key already exists — dedup is resolved by the engine
   * based on `executeMode`.
   */
  async start(
    name: string,
    input: unknown,
    options: SubmitOptions = {},
  ): Promise<TaskHandle> {
    this.assertAlive();
    return this.telemetry.startActiveSpan(
      "tasks.start",
      { attributes: { "task.name": name } },
      async (span) => {
        try {
          const handle = await this.engine.submit(name, input, options);
          span.setAttribute("task.id", handle.taskId);
          span.setStatus({ code: SpanStatusCode.OK });
          this.metrics.starts.add(1, { "task.name": name });
          return handle;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        }
      },
    );
  }

  /**
   * Returns the current task record, or `null` if not found / unauthorized.
   *
   * **Auth contract:** the engine does NOT authenticate. The `userId`
   * passed here is matched against the submit-time owner only to gate
   * existence — the embedder MUST verify the caller's identity at the
   * route layer (e.g. from `x-forwarded-user`) before forwarding it.
   */
  async reconnect(
    idempotencyKey: string,
    userId?: string,
  ): Promise<Task | null> {
    this.assertAlive();
    return this.telemetry.startActiveSpan(
      "tasks.reconnect",
      { attributes: { "task.idempotencyKey": idempotencyKey } },
      async (span) => {
        const task = await this.engine.reconnect(idempotencyKey, userId);
        span.setAttribute("task.found", task !== null);
        span.setStatus({ code: SpanStatusCode.OK });
        this.metrics.reconnects.add(1, {
          result: task ? "found" : "notfound",
        });
        return task;
      },
    );
  }

  /**
   * Revives a suspended task — after a deliberate `stop()` or, for an OBO
   * task, after a crash (auto-recovery is disabled in that case).
   *
   * **Auth contract:** see {@link reconnect}. The engine never reveals
   * existence to a caller whose `userId` mismatches the owner; verify
   * the value at the route layer before forwarding.
   */
  async resume(
    idempotencyKey: string,
    options: ResumeOptions = {},
  ): Promise<Task | null> {
    this.assertAlive();
    return this.telemetry.startActiveSpan(
      "tasks.resume",
      { attributes: { "task.idempotencyKey": idempotencyKey } },
      async (span) => {
        const task = await this.engine.resume(idempotencyKey, options);
        span.setAttribute("task.found", task !== null);
        span.setStatus({ code: SpanStatusCode.OK });
        this.metrics.resumes.add(1, { result: task ? "found" : "notfound" });
        return task;
      },
    );
  }

  /**
   * Cooperative stop. Emits a `suspended` event. Idempotent.
   *
   * **Auth contract:** see {@link reconnect}. A mismatched `userId`
   * surfaces as `TaskNotFound`; verify the value at the route layer
   * before forwarding.
   */
  async stop(
    idempotencyKey: string,
    options: StopOptions = {},
  ): Promise<TaskHandle> {
    this.assertAlive();
    return this.telemetry.startActiveSpan(
      "tasks.stop",
      { attributes: { "task.idempotencyKey": idempotencyKey } },
      async (span) => {
        try {
          const handle = await this.engine.stop(idempotencyKey, options);
          span.setStatus({ code: SpanStatusCode.OK });
          this.metrics.stops.add(1);
          return handle;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        }
      },
    );
  }

  /** Drains in-flight tasks and shuts the engine down. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.hasShutdown) return;
    this.hasShutdown = true;
    logger.info("Shutting down task engine");
    await this.engine.shutdown();
    if (TaskManager._instance === this) {
      TaskManager._instance = null;
    }
  }

  /**
   * Async iterable of `StreamEvent`s ordered by sequence number. Pass
   * `lastSeq` to resume from a known position (SSE reconnection).
   */
  subscribe(
    idempotencyKey: string,
    lastSeq?: number,
  ): AsyncIterableIterator<StreamEvent> {
    this.assertAlive();
    this.metrics.subscriptions.add(1);
    return this.engine.subscribe(idempotencyKey, lastSeq);
  }

  /**
   * Test-only: aborts the executor mid-run without writing a terminal
   * event so reconnect/recovery exercises the crash path. Throws unless
   * `engine.enableTestMode: true` was set at boot.
   *
   * @internal
   */
  simulateCrash(idempotencyKey: string): void {
    this.assertAlive();
    this.engine.simulateCrash(idempotencyKey);
  }

  /**
   * Test-only singleton reset. Hard-fails in production. Shuts down the
   * previous engine before zeroing the pointer so workers and storage
   * handles don't leak across tests.
   *
   * @internal
   */
  static async _resetForTests(): Promise<void> {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "TaskManager._resetForTests() is test-only and refuses to run when NODE_ENV=production.",
      );
    }
    const prev = TaskManager._instance;
    TaskManager._instance = null;
    if (prev) await prev.shutdown().catch(() => {});
  }

  private assertAlive(): void {
    if (this.hasShutdown) {
      throw new Error("TaskManager has been shut down.");
    }
  }
}

/**
 * Warns when SQLite is paired with a Databricks Apps environment — the
 * per-pod filesystem cannot survive rolling restarts, so durability
 * silently degrades. We can't refuse to boot since single-process dev
 * looks identical at the config level.
 */
function warnOnEphemeralStorage(config: TaskConfig): void {
  const isDatabricksApps =
    !!process.env.DATABRICKS_APP_NAME ||
    !!process.env.DATABRICKS_APP_ID ||
    !!process.env.DATABRICKS_APP_URL;
  if (!isDatabricksApps) return;
  const backend = config.storage?.backend ?? "sqlite";
  if (backend !== "sqlite") return;
  logger.warn(
    "Tasks configured with the SQLite backend but the runtime appears " +
      "to be Databricks Apps (multi-pod, no shared volume). Tasks will " +
      "not survive rolling restarts. For production, switch the backend " +
      "to `lakebase` (Postgres) via `task: { storage: { backend: " +
      "'lakebase', connectionString: … } }`.",
  );
}
