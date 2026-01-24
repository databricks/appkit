import type { TaskEvent, TaskEventInput } from "./events";
import type { TaskExecutionOptions } from "./types";

/**
 * Context provided to task handlers during execution
 */
export interface TaskHandlerContext {
  /** Unique task ID */
  taskId: string;
  /** Task name/template */
  name: string;
  /** User ID (null for background tasks) */
  userId: string | null;
  /** Idempotency key for deduplication */
  idempotencyKey: string;
  /** Current attempt number (1-indexed) */
  attempt: number;
  /** AbortSignal for cancellation */
  signal: AbortSignal;
}

export interface RecoveryContext extends TaskHandlerContext {
  /** Previous events from the failed execution */
  previousEvents: TaskEvent[];
  /** Reason for recovery */
  recoveryReason: "stale" | "crash" | "timeout";
  /** Time since last event in milliseconds */
  timeSinceLastEventMs: number;
}

/**
 * Result of a task handler function
 */
export type TaskHandlerResult<T = unknown> = T | void;

/**
 * Async generator handler that can yield progress events
 *
 * @example
 * async function* myHandler(input: MyInput, context: TaskHandlerContext) {
 *   yield { type: "progress", message: "Starting..." };
 *   const result = await doWork(input);
 *   yield { type: "progress", message: "Almost done...", payload: { percent: 90 } };
 *   return result;
 * }
 */
export type GeneratorTaskHandler<TInput = unknown, TResult = unknown> = (
  input: TInput,
  context: TaskHandlerContext,
) => AsyncGenerator<TaskEventInput, TResult, unknown>;

/**
 * Promise-based handler that returns a result directly
 *
 * @example
 * async function myHandler(input: MyInput, context: TaskHandlerContext) {
 *   const result = await doWork(input);
 *   return result;
 * }
 */
export type PromiseTaskHandler<TInput = unknown, TResult = unknown> = (
  input: TInput,
  context: TaskHandlerContext,
) => Promise<TaskHandlerResult<TResult>>;

/**
 * Union type for all supported handler types
 */
export type TaskHandler<TInput = unknown, TResult = unknown> =
  | GeneratorTaskHandler<TInput, TResult>
  | PromiseTaskHandler<TInput, TResult>;

/**
 * Recovery handler for resuming failed/stale tasks
 *
 * Receives previous events for smart recovery
 * @example
 * async function* recoveryHandler(input: MyInput, ctx: RecoveryContext) {
 *   // check what was already done
 *   const statementId = ctx.previousEvents.find(e => e.payload?.statementId)?.payload?.statementId;
 *   if(statementId) {
 *     // already created the statement, so we can resume for polling
 *     const result = await pollForStatementResult(statementId);
 *     yield { type: "complete", message: "Statement completed", result: result };
 *   } else {
 *     // start from scratch
 *     yield { type: "created", message: "Starting from scratch" };
 *     const result = await createStatement(input);
 *     yield { type: "progress", message: "Statement created", payload: { statementId: result.statementId } };
 *     // now we can poll for the result
 *     const result = await pollForStatementResult(result.statementId);
 *     yield { type: "complete", message: "Statement completed", result: result };
 *   }
 * }
 */
export type RecoveryHandler<TInput = unknown, TResult = unknown> = (
  input: TInput,
  ctx: RecoveryContext,
) => AsyncGenerator<TaskEventInput, TResult, unknown>;

/**
 * Task definition for registration and execution
 */
export interface TaskDefinition<TInput = unknown, TResult = unknown> {
  /** Unique task name */
  name: string;
  /** Main execution handler */
  handler: TaskHandler<TInput, TResult>;
  /** Optional recovery handler for smart recovery */
  recover?: RecoveryHandler<TInput, TResult>;
  /** Task description for documentation */
  description?: string;
  /** Default execution options */
  defaultOptions: TaskExecutionOptions;
}

/**
 * Type guard to check if a value is an AsyncGenerator
 */
export function isAsyncGenerator<T, TReturn, TNext>(
  value: unknown,
): value is AsyncGenerator<T, TReturn, TNext> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncGenerator<T, TReturn, TNext>).next === "function"
  );
}
