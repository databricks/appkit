/** Handle returned from {@link Taskflow.submit}. `taskId` may change on TTL readmit; `idempotencyKey` is stable. */
export interface TaskHandle {
    taskId: string;
    idempotencyKey: string;
}

export interface Task {
    id: string;
    name: string;
    idempotencyKey: string;
    userId: string | null;
    status: string;
    input: any;
    result: any | null;
    error: string | null;
    createdAtMs: number;
    startedAtMs: number | null;
    completedAtMs: number | null;
    attempt: number;
    timeoutMs: number | null;
    maxAttempts: number | null;
}

export interface TaskEvent {
    id: string;
    taskId: string;
    idempotencyKey: string;
    seq: number;
    eventType: string;
    timestampMs: number;
    payload: any;
}

export interface StreamEvent {
    streamSeq: number;
    event: TaskEvent;
}

export interface SubmitOptions {
    /**
     * Caller identity for ownership checks on later `reconnect` / `resume` /
     * `stop`. The engine does not authenticate; the embedder must verify this
     * value (e.g., from a session token) before passing it in.
     */
    userId?: string;
    /**
     * Dedup strictness. Defaults to `at_least_once` (fast path; cache-backed).
     * Use `at_most_once` for non-idempotent transactions; the engine then
     * always queries storage before creating the task, sacrificing latency for
     * stronger cross-pod uniqueness.
     */
    executeMode?: 'at_least_once' | 'at_most_once';
    /** Per-attempt handler timeout. Falls back to `executor.defaultTimeoutMs`. */
    timeoutMs?: number;
    /**
     * Per-task retry budget (overrides `executor.retry.maxAttempts`). The
     * count includes the first try, so `maxAttempts: 3` means up to 2 retries.
     */
    maxAttempts?: number;
    /**
     * Live JS object passed through to the handler as `ctx.context`. Stored
     * in the FFI sidecar (see `stream.contextSidecarCapacity`); released
     * automatically when the executor exits. Never serialised: not durable
     * across crashes; not visible to handlers re-spawned on a different pod
     * by the recovery worker.
     */
    context?: any;
}

export interface RegisterTaskOptions {
    /**
     * Whether the recovery worker should re-spawn this task automatically
     * after a stale heartbeat. Defaults to `true`. Set to `false` when the
     * task should only be revived by an explicit external trigger
     * (`engine.resume(...)`).
     */
    autoRecover?: boolean;
    /** Per-handler override of `engine.recoveryMaxAgeMs`; `0` always fail-and-readmits; omit to use the engine default. */
    recoveryMaxAgeMs?: number;
}

export interface ResumeOptions {
    /**
     * Ownership check: must equal the `userId` passed at submit time.
     * Mismatch returns `null` (the engine never reveals existence to an
     * unauthorised caller). The engine does not authenticate; the embedder
     * must verify this value before passing it in.
     */
    userId?: string;
    /**
     * Live JS object for the new attempt's `ctx.context`. Replaces the
     * spawn-time context, which has already been released. See
     * `SubmitOptions.context` for lifetime caveats.
     */
    context?: any;
}

export interface StopOptions {
    /**
     * Ownership check: must equal the `userId` passed at submit time.
     * Mismatch returns `TaskNotFound` (the engine never reveals existence to
     * an unauthorised caller). The engine does not authenticate; the
     * embedder must verify this value before passing it in.
     */
    userId?: string;
    /**
     * Human-readable reason persisted with the suspension event. Surfaced to
     * every `subscribe` consumer and bounded by
     * `MAX_SUSPENDED_REASON_LEN` (512 chars). Defaults to `"stopped via API"`.
     */
    reason?: string;
}

export interface TaskContext {
    readonly taskId: string;
    readonly idempotencyKey: string;
    readonly userId: string | null;
    readonly attempt: number;
    readonly previousEvents: TaskEvent[];
    readonly isRecovery: boolean;
    readonly context: any | null;

    emit(eventType: string, payload?: any): Promise<void>;
    heartbeat(): Promise<void>;
}

export interface TaskDefinition<TInput = any, TResult = any> {
    name: string;
    execute(input: TInput, ctx: TaskContext): Promise<TResult>;
    recover?(input: TInput, ctx: TaskContext): Promise<TResult>;
    autoRecover?: boolean;
    /** Per-task override of `engine.recoveryMaxAgeMs`. */
    recoveryMaxAgeMs?: number;
}

export interface TaskflowConfig {
    engine?: {
        walPath?: string;
        flushIntervalMs?: number;
        recoveryIntervalMs?: number;
        staleThresholdMs?: number;
        flushMaxBatchSize?: number;
        recoveryMaxPerCycle?: number;
        shutdownGracePeriodMs?: number;
        shutdownDeadlineMs?: number;
        recoveryTaskTimeoutMs?: number;
        /** Background GC cap for abandoned Suspended rows. Defaults to 7 days; `0` disables expiry. */
        suspendedMaxAgeMs?: number;
        /** Max age (ms) of a non-terminal task still eligible for recovery. Default `300000`. Must be `> 0`; use a large value to effectively disable globally. */
        recoveryMaxAgeMs?: number;
        enableTestMode?: boolean;
    };
    wal?: {
        maxSegmentBytes?: number;
        minSegmentsRetained?: number;
        maxPendingWrites?: number;
        maxBatchSize?: number;
    };
    admission?: {
        guard?: { globalRateLimit?: number; perUserRateLimit?: number };
        slots?: { globalLimit?: number; perUserLimit?: number };
    };
    executor?: {
        retry?: {
            maxAttempts?: number;
            initialDelayMs?: number;
            maxDelayMs?: number;
            backoffMultiplier?: number;
        };
        heartbeatIntervalMs?: number;
        defaultTimeoutMs?: number;
    };
    storage?:
    | {
        backend: 'sqlite';
        databasePath?: string;
        maxConnections?: number;
        connectionTimeoutMs?: number;
        maxEventsPerTask?: number;
        retry?: StorageRetryConfig;
    }
    | {
        backend: 'lakebase';
        connectionString?: string;
        maxConnections?: number;
        connectionTimeoutMs?: number;
        maxEventsPerTask?: number;
        retry?: StorageRetryConfig;
    };
    stream?: {
        bufferCapacity?: number;
        retentionMs?: number;
        channelCapacity?: number;
        reapIntervalMs?: number;
        contextSidecarCapacity?: number;
    };
}

export interface StorageRetryConfig {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
}

/**
 * Thrown from inside a handler (or `workflow.awaitSignal` / `workflow.waitAll`)
 * to cooperatively suspend the running task. The engine moves the task to
 * `Suspended`; revive it with `resume`. Mirrors Python's `taskflow.Suspend`.
 */
export declare class Suspend extends Error {
    constructor();
}

// Low-level API: native `Engine` bindings.

export declare class Engine {
    static create(config?: TaskflowConfig): Promise<Engine>;
    registerTask<TInput = any, TResult = any>(definition: TaskDefinition<TInput, TResult>): void;
    submit(name: string, input: any, options?: SubmitOptions): Promise<TaskHandle>;
    reconnect(idempotencyKey: string, userId?: string): Promise<Task | null>;
    /**
     * Revive a `Suspended` task and start a fresh attempt.
     *
     * Returns `null` if the task does not exist, has been moved to a terminal
     * state, is no longer `Suspended`, OR if the caller's `userId` does not
     * match the submit-time owner — these cases are intentionally indistinguishable
     * to prevent existence probing by unauthorised callers. Throws on
     * underlying engine errors (storage, slot exhaustion).
     */
    resume(idempotencyKey: string, options?: ResumeOptions): Promise<Task | null>;
    /**
     * Move a task into `Suspended` and raise the stop intent.
     *
     * For `Created` tasks this is a synchronous durable transition; for
     * `Running` tasks the stop intent is honoured by the next heartbeat.
     * **Naming note:** despite the verb, this emits a `suspended` event, not
     * a `stopped` event — the JS-side method is named `stop` because that is
     * the user-facing verb, but the underlying semantics are identical to
     * `engine.suspend(...)`. Use `resume` to revive the task; use
     * `cancelTask` for a true terminal cancellation. Idempotent.
     *
     * Throws `TaskNotFound` if the task does not exist or the caller's
     * `userId` does not match the owner.
     */
    stop(idempotencyKey: string, options?: StopOptions): Promise<TaskHandle>;
    cancelTask(idempotencyKey: string): void;
    subscribe(idempotencyKey: string, lastSeq?: number): AsyncIterableIterator<StreamEvent>;
    shutdown(): Promise<void>;
    /**
     * Test-only. Aborts the executor mid-run without writing a terminal
     * event so a subsequent reconnect/recovery exercises the crash path.
     * Throws `TestModeDisabled` unless `engine.enableTestMode = true` in the
     * config; production deployments must leave this disabled.
     */
    simulateCrash(idempotencyKey: string): void;
    /** Engine metrics report as a JSON string. */
    metricsJson(): string;
    /** Engine metrics report as a human-readable string. */
    metricsPretty(): string;
}

// High-level SDK: same shape as the Python `Taskflow` helpers.

export declare class Taskflow {
    constructor(config?: TaskflowConfig);

    static task(name: string, fn: (input: any, ctx: TaskContext) => Promise<any>): typeof fn;
    static task(name: string, options?: {
        recover?: (input: any, ctx: TaskContext) => Promise<any>;
        autoRecover?: boolean;
        recoveryMaxAgeMs?: number;
    }): (fn: (input: any, ctx: TaskContext) => Promise<any>) => typeof fn;

    static start(name: string, input: any, userId?: string): Promise<TaskHandle>;
    static start(name: string, input: any, options?: SubmitOptions): Promise<TaskHandle>;
    /** See `Engine.resume`. */
    static resume(idempotencyKey: string, options?: ResumeOptions): Promise<Task | null>;
    /** See `Engine.stop`. */
    static stop(idempotencyKey: string, options?: StopOptions): Promise<TaskHandle>;
    static subscribe(
        idempotencyKey: string,
        lastSeq?: number,
        userId?: string,
    ): Promise<AsyncIterableIterator<StreamEvent>>;
    /**
     * Block until the task reaches a terminal state or emits a completion
     * event, resolving with its result. Polls `subscribe` + `reconnect`;
     * rejects with a `TimeoutError` if `options.timeoutMs` elapses first.
     */
    static wait(
        idempotencyKey: string,
        options?: { timeoutMs?: number; userId?: string },
    ): Promise<any>;
    /** Test-only. See `Engine.simulateCrash`. */
    static simulateCrash(idempotencyKey: string): Promise<void>;
    static shutdown(): Promise<void>;
    /** Engine metrics report as a JSON string. */
    static metricsJson(): Promise<string>;
    /** Engine metrics report as a human-readable string. */
    static metricsPretty(): Promise<string>;
}

// Workflow primitives: opinionated helpers; callers may extend them.

type StepFn<TArgs extends any[] = any[], TResult = any> =
    (ctx: TaskContext, ...args: TArgs) => Promise<TResult>;

export declare namespace workflow {
    function step<TArgs extends any[], TResult>(
        fn: StepFn<TArgs, TResult>,
    ): StepFn<TArgs, TResult>;

    function findEvent(ctx: TaskContext, eventType: string): TaskEvent | null;

    /**
     * Durable signal receive. Resolves with the signal body when
     * `ctx.context.payload` matches `topic`; otherwise suspends the task (throws
     * `Suspend`) to be revived by a later `resume`. `options.timeoutMs` is
     * reserved for durable timers and currently ignored.
     */
    function awaitSignal(
        ctx: TaskContext,
        topic: string,
        options?: { timeoutMs?: number },
    ): Promise<any>;

    /**
     * Resolve once every child key has emitted `child_done:{key}`; suspends
     * (throws `Suspend`) until all are present.
     */
    function waitAll(
        ctx: TaskContext,
        childKeys: string[],
    ): Promise<Record<string, any>>;
}
