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
  TaskContext,
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
import type {
  ActiveBridge,
  TaskDefinition,
  TaskHandleRef,
  TaskRegistrationRecord,
} from "./types";
import { loadVendorModule } from "./vendor-loader";

const logger = createLogger("tasks");

/**
 * Build the registration options object passed to the vendor engine's
 * `registerTask`. Validates `recoveryMaxAgeMs` so a bad value surfaces
 * at registration time rather than as an opaque native error.
 */
function buildRegisterOpts(definition: {
  name: string;
  autoRecover?: boolean;
  recoveryMaxAgeMs?: number;
}): { autoRecover?: boolean; recoveryMaxAgeMs?: number } | null {
  const opts: { autoRecover?: boolean; recoveryMaxAgeMs?: number } = {};
  if (definition.autoRecover !== undefined) {
    opts.autoRecover = definition.autoRecover;
  }
  if (definition.recoveryMaxAgeMs !== undefined) {
    const v = definition.recoveryMaxAgeMs;
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      !Number.isInteger(v) ||
      v < 0
    ) {
      throw new Error(
        `task '${definition.name}': recoveryMaxAgeMs must be a non-negative integer (got ${String(
          v,
        )})`,
      );
    }
    opts.recoveryMaxAgeMs = v;
  }
  return Object.keys(opts).length === 0 ? null : opts;
}

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
  private readonly registrations = new Map<string, TaskRegistrationRecord>();
  private readonly activeBridges = new Set<ActiveBridge>();
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
   * Registers a durable task. Call from the plugin's `setup()` hook
   * with handlers bound to the plugin instance. `TEvents` constrains
   * `ctx.emit(name, payload)`, which is also the SSE wire shape.
   *
   * @example
   * ```ts
   * type AgentEvents = { turn_done: { turn: number; result: string } };
   *
   * this.task.task<AgentInput, AgentOutput, AgentEvents>({
   *   name: "agent-loop",
   *   execute: async (input, ctx) => {
   *     await ctx.emit("turn_done", { turn: 1, result: "ok" });
   *   },
   *   autoRecover: false,
   * });
   * ```
   */
  task<
    TInput = unknown,
    TResult = unknown,
    TEvents extends Record<string, unknown> = Record<string, unknown>,
  >(
    definition: TaskDefinition<TInput, TResult, TEvents>,
  ): TaskHandleRef<TInput, TResult, TEvents> {
    this.assertAlive();
    if (this.registrations.has(definition.name)) {
      // Throw in prod so a duplicate doesn't silently shadow the first
      // handler (recovery worker would route in-flight tasks to a stale
      // closure). Warn-only in dev so HMR loops keep working.
      const message = `Task "${definition.name}" is already registered.`;
      if (process.env.NODE_ENV === "production") {
        throw new Error(message);
      }
      logger.warn(`${message} (allowed in non-production)`);
    }
    // TODO(taskflow#engine-binding-reconciliation): vendored
    // `registerTask` is positional at runtime even though the .d.ts
    // documents the object form. `TypedTaskContext` is compile-time
    // only — at runtime emit is unconstrained `(string, any)`.
    const recoverFn = definition.recover ?? null;
    const registerOpts = buildRegisterOpts(definition);
    (
      this.engine as unknown as {
        registerTask(
          n: string,
          exec: (input: unknown, ctx: TaskContext) => Promise<unknown>,
          recover:
            | ((input: unknown, ctx: TaskContext) => Promise<unknown>)
            | null,
          opts: { autoRecover?: boolean; recoveryMaxAgeMs?: number } | null,
        ): void;
      }
    ).registerTask(
      definition.name,
      definition.execute as unknown as (
        input: unknown,
        ctx: TaskContext,
      ) => Promise<unknown>,
      recoverFn as unknown as
        | ((input: unknown, ctx: TaskContext) => Promise<unknown>)
        | null,
      registerOpts,
    );
    this.registrations.set(definition.name, {
      autoRecover: definition.autoRecover ?? true,
      hasRecover: typeof definition.recover === "function",
      recoveryMaxAgeMs: definition.recoveryMaxAgeMs,
    });
    return { name: definition.name } as TaskHandleRef<TInput, TResult, TEvents>;
  }

  /** Process-local lookup; not cross-pod. */
  hasTask(name: string): boolean {
    return this.registrations.has(name);
  }

  /** Used by `executeTask` to surface OBO misconfigurations. @internal */
  getRegistration(name: string): TaskRegistrationRecord | undefined {
    return this.registrations.get(name);
  }

  /**
   * Registers an SSE bridge so shutdown can drain it with a graceful
   * `event: error` / `server_shutting_down` frame before the engine
   * closes the subscription. Returns an unregister callback.
   * @internal
   */
  _registerBridge(bridge: ActiveBridge): () => void {
    if (this.hasShutdown) {
      try {
        bridge.drain("server_shutting_down");
      } catch (err) {
        logger.debug("Bridge drain after shutdown threw: %O", err);
      }
      return () => {};
    }
    this.activeBridges.add(bridge);
    return () => {
      this.activeBridges.delete(bridge);
    };
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
    // Drain bridges before the engine — otherwise iterators close and
    // clients see a silent EOF instead of an actionable error frame.
    if (this.activeBridges.size > 0) {
      logger.debug(
        `Draining ${this.activeBridges.size} active SSE bridge(s) before engine shutdown`,
      );
      for (const bridge of this.activeBridges) {
        try {
          bridge.drain("server_shutting_down");
        } catch (err) {
          logger.debug(
            `Bridge drain failed for IK ${bridge.idempotencyKey}: %O`,
            err,
          );
        }
      }
      this.activeBridges.clear();
    }
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
