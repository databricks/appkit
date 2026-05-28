import type { TaskContext, TaskEvent } from "../../vendor/taskflow/taskflow.js";

/**
 * `TaskContext` whose `emit` is narrowed to a declared event-name →
 * payload-shape map. Plugins opt in via the `TEvents` parameter on
 * {@link TaskDefinition}; the default keeps the engine's looser
 * `(string, any)` shape.
 *
 * @public
 */
export interface TypedTaskContext<TEvents extends Record<string, unknown>>
  extends Omit<TaskContext, "emit"> {
  emit<K extends keyof TEvents & string>(
    name: K,
    payload: TEvents[K],
  ): Promise<void>;
}

/**
 * Durable task registration accepted by {@link TaskManager.task}.
 * `TEvents` ties `ctx.emit(name, payload)` to a typed map — those names
 * and shapes are exactly the SSE wire frames the client sees.
 *
 * @public
 */
export interface TaskDefinition<
  TInput = unknown,
  TResult = unknown,
  TEvents extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  execute(input: TInput, ctx: TypedTaskContext<TEvents>): Promise<TResult>;
  recover?(input: TInput, ctx: TypedTaskContext<TEvents>): Promise<TResult>;
  autoRecover?: boolean;
  /**
   * Registration-time override for `engine.recoveryMaxAgeMs` scoped to
   * this task. Tasks whose age exceeds this deadline are atomically
   * failed by TaskFlow before any recovery or auto-resume attempt; on
   * the submit path TaskFlow then admits a fresh task under the same
   * content-addressed idempotency key. `0` disables recovery for this
   * task type (always fail-and-readmit). Omit to defer to the engine
   * default.
   *
   * Runtime policy only — never participates in the idempotency key.
   */
  recoveryMaxAgeMs?: number;
}

/**
 * Branded handle returned by {@link TaskManager.task}. Carries the
 * registered name plus phantom type parameters so callers that take
 * `TaskRef | string` can infer input and event shapes without a
 * redundant generic.
 *
 * @public
 */
export interface TaskHandleRef<
  TInput = unknown,
  TResult = unknown,
  TEvents extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly name: string;
  /** Phantom marker dragging `TInput`/`TResult`/`TEvents` into the type. Never read at runtime. @internal */
  readonly __taskTypes?: {
    input: TInput;
    result: TResult;
    events: TEvents;
  };
}

/** Convenience alias for {@link TaskHandleRef}. @public */
export type TaskRef<
  TInput = unknown,
  TResult = unknown,
  TEvents extends Record<string, unknown> = Record<string, unknown>,
> = TaskHandleRef<TInput, TResult, TEvents>;

/** Captured per-registration so we can surface diagnostics (OBO + autoRecover). @internal */
export interface TaskRegistrationRecord {
  autoRecover: boolean;
  hasRecover: boolean;
  /** Resolved registration-time recovery-TTL override, if any. @internal */
  recoveryMaxAgeMs?: number;
}

/**
 * Active SSE bridge handle. The service keeps a set of these so it can
 * drain in-flight bridges (write a final `event: error` frame) before
 * the engine closes their iterators on shutdown.
 * @internal
 */
export interface ActiveBridge {
  /** For log context only — never used for ownership. */
  idempotencyKey: string;
  /** Best-effort: write SSE error frame, stop subscribing. Errors are swallowed. */
  drain(reason: string): void;
}

/** Re-exported for callers that work with raw engine events. @public */
export type { TaskEvent };
