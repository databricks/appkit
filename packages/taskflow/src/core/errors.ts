import type { TaskStatus } from "./types";

/**
 * Error context that can be attached to any TaskSystemError
 */
export interface ErrorContext {
  taskId?: string;
  userId?: string;
  templateName?: string;
  idempotencyKey?: string;
  [key: string]: unknown; // allow any additional context
}

/**
 * Structured error codes for consistent error handling
 */
export const ErrorCodes = {
  // validation errors
  VALIDATION_FAILED: "VALIDATION_FAILED",
  CONFIG_VALIDATION_FAILED: "CONFIG_VALIDATION_FAILED",

  // resource errors
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  HANDLER_NOT_FOUND: "HANDLER_NOT_FOUND",

  // state errors
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  CONFLICT: "CONFLICT",

  // rate limiting / capacity errors
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  SLOT_TIMEOUT: "SLOT_TIMEOUT",
  BACKPRESSURE: "BACKPRESSURE",

  // execution errors
  RETRY_EXHAUSTED: "RETRY_EXHAUSTED",
  STREAM_OVERFLOW: "STREAM_OVERFLOW",

  // system errors
  INITIALIZATION_FAILED: "INITIALIZATION_FAILED",

  // persistence errors
  EVENTLOG_WRITE_FAILED: "EVENTLOG_WRITE_FAILED",
  EVENTLOG_ROTATION_FAILED: "EVENTLOG_ROTATION_FAILED",
  REPOSITORY_MIGRATION_FAILED: "REPOSITORY_MIGRATION_FAILED",
  REPOSITORY_QUERY_FAILED: "REPOSITORY_QUERY_FAILED",
  REPOSITORY_BATCH_FAILED: "REPOSITORY_BATCH_FAILED",
  INVALID_PATH: "INVALID_PATH",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Base error class for all task system errors
 * Provides structured error handling with context, timestamps, and cause chains.
 */
export class TaskSystemError extends Error {
  readonly code: ErrorCode;
  readonly context?: ErrorContext;
  readonly timestamp: number;
  readonly cause?: Error;

  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.VALIDATION_FAILED,
    context?: ErrorContext,
    cause?: Error,
  ) {
    super(message);
    this.name = "TaskSystemError";
    this.code = code;
    this.context = context;
    this.timestamp = Date.now();
    this.cause = cause;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Type guard to check if an error is a TaskSystemError
   */

  static is(value: unknown): value is TaskSystemError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "TaskSystemError"
    );
  }

  /**
   * Serializes the error to a JSON-compatible object
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp,
      cause: this.cause
        ? {
            name: this.cause.name,
            message: this.cause.message,
          }
        : undefined,
      stack: this.stack,
    };
  }
}

/**
 * Validation error for invalid task input or configuration
 */
export class ValidationError extends TaskSystemError {
  readonly field?: string;

  constructor(message: string, field?: string, context?: ErrorContext) {
    super(message, ErrorCodes.VALIDATION_FAILED, context);
    this.name = "ValidationError";
    this.field = field;
  }

  static is(value: unknown): value is ValidationError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "ValidationError"
    );
  }
}

/**
 * Configuration validation error for invalid system configuration
 */
export class ConfigValidationError extends TaskSystemError {
  readonly configPath?: string;

  constructor(message: string, configPath?: string, context?: ErrorContext) {
    super(message, ErrorCodes.CONFIG_VALIDATION_FAILED, {
      ...context,
      configPath,
    });
    this.name = "ConfigValidationError";
    this.configPath = configPath;
  }

  static is(value: unknown): value is ConfigValidationError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "ConfigValidationError"
    );
  }
}

/**
 * Resource not found error
 */
export class NotFoundError extends TaskSystemError {
  readonly resourceType: "task" | "template" | "handler";

  constructor(
    message: string,
    resourceType: "task" | "template" | "handler",
    context?: ErrorContext,
  ) {
    const code =
      resourceType === "task"
        ? ErrorCodes.TASK_NOT_FOUND
        : resourceType === "template"
          ? ErrorCodes.TEMPLATE_NOT_FOUND
          : ErrorCodes.HANDLER_NOT_FOUND;
    super(message, code, { ...context, resourceType });
    this.name = "NotFoundError";
    this.resourceType = resourceType;
  }

  static is(value: unknown): value is NotFoundError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "NotFoundError"
    );
  }
}

/**
 * Conflict error for duplicate operations
 */
export class ConflictError extends TaskSystemError {
  constructor(message: string, context?: ErrorContext) {
    super(message, ErrorCodes.CONFLICT, context);
    this.name = "ConflictError";
  }

  static is(value: unknown): value is ConflictError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "ConflictError"
    );
  }
}

/**
 * Invalid state transition error
 */
export class TaskStateError extends TaskSystemError {
  readonly currentState?: TaskStatus;
  readonly attemptedTransition?: TaskStatus;
  readonly validTransitions?: readonly TaskStatus[];

  constructor(
    message: string,
    currentState?: TaskStatus,
    attemptedTransition?: TaskStatus,
    validTransitions?: readonly TaskStatus[],
  ) {
    super(message, ErrorCodes.INVALID_STATE_TRANSITION, {
      currentState,
      attemptedTransition,
      validTransitions: validTransitions,
    });

    this.name = "TaskStateError";
    this.currentState = currentState;
    this.attemptedTransition = attemptedTransition;
    this.validTransitions = validTransitions;
  }

  static is(value: unknown): value is TaskStateError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "TaskStateError"
    );
  }
}

/**
 * Slot acquisition timeout error
 */
export class SlotTimeoutError extends TaskSystemError {
  readonly timeoutMs?: number;
  constructor(message: string, timeoutMs?: number, context?: ErrorContext) {
    super(message, ErrorCodes.SLOT_TIMEOUT, { ...context, timeoutMs });
    this.name = "SlotTimeoutError";
    this.timeoutMs = timeoutMs;
  }

  static is(value: unknown): value is SlotTimeoutError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "SlotTimeoutError"
    );
  }
}

/**
 * HTTP 429 response structure for backpressure errors
 */
export interface HTTP429Response {
  status: 429;
  headers: {
    "Retry-After"?: string;
    "X-RateLimit-Limit"?: string;
    "X-RateLimit-Remaining"?: string;
  };
  body: {
    error: string;
    message: string;
    retryAfterMs: number;
  };
}

export class BackpressureError extends TaskSystemError {
  readonly limit?: number;
  readonly remaining?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    limit?: number,
    remaining?: number,
    retryAfterMs?: number,
    context?: ErrorContext,
  ) {
    super(message, ErrorCodes.BACKPRESSURE, {
      ...context,
      limit,
      remaining,
      retryAfterMs,
    });
    this.name = "BackpressureError";
    this.limit = limit;
    this.remaining = remaining;
    this.retryAfterMs = retryAfterMs;
  }

  static is(value: unknown): value is BackpressureError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "BackpressureError"
    );
  }

  toHTTPResponse(): HTTP429Response {
    return {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil((this.retryAfterMs ?? 1000) / 1000)),
        "X-RateLimit-Limit": String(this.limit ?? 0),
        "X-RateLimit-Remaining": String(this.remaining ?? 0),
      },
      body: {
        error: "TooManyRequests",
        message: this.message,
        retryAfterMs: this.retryAfterMs ?? 1000,
      },
    };
  }
}

/**
 * Initialization error for component startup failures
 */
export class InitializationError extends TaskSystemError {
  readonly component?: string;

  constructor(message: string, component?: string, context?: ErrorContext) {
    super(message, ErrorCodes.INITIALIZATION_FAILED, { ...context, component });
    this.name = "InitializationError";
    this.component = component;
  }

  static is(value: unknown): value is InitializationError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "InitializationError"
    );
  }
}

/**
 * Retry exhausted error when all retry attempts have failed
 */
export class RetryExhaustedError extends TaskSystemError {
  readonly attempts?: number;
  readonly maxAttempts?: number;
  constructor(
    message: string,
    attempts?: number,
    maxAttempts?: number,
    context?: ErrorContext,
    cause?: Error,
  ) {
    super(
      message,
      ErrorCodes.RETRY_EXHAUSTED,
      {
        ...context,
        attempts,
        maxAttempts,
      },
      cause,
    );
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.maxAttempts = maxAttempts;
  }

  static is(value: unknown): value is RetryExhaustedError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "RetryExhaustedError"
    );
  }
}

/**
 * Stream overflow error when the stream has reached its maximum capacity
 */
export class StreamOverflowError extends TaskSystemError {
  constructor(message: string, context?: ErrorContext) {
    super(message, ErrorCodes.STREAM_OVERFLOW, context);
    this.name = "StreamOverflowError";
  }

  static is(value: unknown): value is StreamOverflowError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "StreamOverflowError"
    );
  }
}

/**
 * EventLog write failure error
 */
export class EventLogError extends TaskSystemError {
  readonly operation: "write" | "rotate" | "compact" | "read";
  readonly path?: string;

  constructor(
    message: string,
    operation: "write" | "rotate" | "compact" | "read",
    path?: string,
    cause?: Error,
  ) {
    super(
      message,
      operation === "write"
        ? ErrorCodes.EVENTLOG_WRITE_FAILED
        : ErrorCodes.EVENTLOG_ROTATION_FAILED,
      { path, operation },
      cause,
    );
    this.name = "EventLogError";
    this.operation = operation;
    this.path = path;
  }

  static is(value: unknown): value is EventLogError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "EventLogError"
    );
  }
}

/**
 * Repository operation failure error
 */
export class RepositoryError extends TaskSystemError {
  readonly repositoryType: "sqlite" | "lakebase";
  readonly operation: "query" | "batch" | "migration";
  readonly isRetryable: boolean;

  constructor(
    message: string,
    repositoryType: "sqlite" | "lakebase",
    operation: "query" | "batch" | "migration",
    isRetryable = false,
    cause?: Error,
  ) {
    const code =
      operation === "migration"
        ? ErrorCodes.REPOSITORY_MIGRATION_FAILED
        : operation === "query"
          ? ErrorCodes.REPOSITORY_QUERY_FAILED
          : ErrorCodes.REPOSITORY_BATCH_FAILED;

    super(message, code, { repositoryType, operation, isRetryable }, cause);
    this.name = "RepositoryError";
    this.repositoryType = repositoryType;
    this.operation = operation;
    this.isRetryable = isRetryable;
  }

  static is(value: unknown): value is RepositoryError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "RepositoryError"
    );
  }
}

/**
 * Invalid path error for security violations
 */
export class InvalidPathError extends TaskSystemError {
  readonly path: string;
  readonly reason: "traversal" | "absolute" | "invalid";

  constructor(path: string, reason: "traversal" | "absolute" | "invalid") {
    super(
      `Invalid path detected: ${reason} in "${path}"`,
      ErrorCodes.INVALID_PATH,
      { path, reason },
    );
    this.name = "InvalidPathError";
    this.path = path;
    this.reason = reason;
  }

  static is(value: unknown): value is InvalidPathError {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Error).name === "InvalidPathError"
    );
  }
}

// Known retryable error patterns
const RETRYABLE_ERROR_PATTERNS = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "timeout",
  "socket hang up",
  "network",
];

// Known permanent error patterns
const PERMANENT_ERROR_PATTERNS = [
  "unauthorized",
  "forbidden",
  "invalid",
  "malformed",
  "not found",
  "bad request",
];

/**
 * Determines if an error is retryable
 *
 * - Returns true for BackpressureError, SlotTimeoutError
 * - Returns true for network-related errors (ECONNRESET, timeout, etc)
 * - Returns false for ValidationError, NotFoundError, TaskStateError
 * - Returns true for unknown errors (fail-safe by default)
 */
export function isRetryableError(error: unknown): boolean {
  // null/undefined are not retryable
  if (error === null || error === undefined) return false;

  // check for known task system errors
  if (isTaskSystemError(error)) {
    // explicit retryable
    if (error instanceof BackpressureError || error instanceof SlotTimeoutError)
      return true;

    // explicit not retryable
    if (
      error instanceof ValidationError ||
      error instanceof ConfigValidationError ||
      error instanceof NotFoundError ||
      error instanceof TaskStateError ||
      error instanceof ConflictError
    )
      return false;
  }

  // RetryExhaustedError means we've already tried - dont retry again
  if (error instanceof RetryExhaustedError) return false;

  // check error for patterns
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  // check for permanent errors patterns first
  if (PERMANENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern)))
    return false;

  // check for retryable patterns
  if (RETRYABLE_ERROR_PATTERNS.some((pattern) => message.includes(pattern)))
    return true;

  // check for http status code in the error
  if (error instanceof Error && "status" in error) {
    const status = (error as Error & { status: number }).status;
    // 4xx errors (except 429) are not retryable
    if (status >= 400 && status < 500 && status !== 429) return false;
    // 5xx errors and 429 are retryable
    if (status >= 500 || status === 429) return true;
  }

  // default: unknown error is retryable (fail-safe)
  return true;
}

/**
 * Type guard to check if an error is a TaskSystemError
 */
export function isTaskSystemError(error: unknown): error is TaskSystemError {
  return error instanceof TaskSystemError;
}
