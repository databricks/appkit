import { AppKitError } from "./base";

/**
 * Error thrown when an operation execution fails.
 * Use for statement failures, canceled operations, or unexpected states.
 *
 * @example
 * ```typescript
 * throw new ExecutionError("Statement failed: syntax error");
 * throw new ExecutionError("Statement was canceled");
 * ```
 */
export class ExecutionError extends AppKitError {
  readonly code = "EXECUTION_ERROR";
  readonly statusCode = 500;
  readonly isRetryable = false;

  /**
   * Structured error code from the upstream source (typically the warehouse's
   * `error_code` for statement-level failures, or the SDK's `ApiError.errorCode`
   * for HTTP failures). Preserved through wrapping so callers can branch on a
   * stable identifier without substring-matching the message.
   */
  readonly errorCode?: string;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
      errorCode?: string;
    },
  ) {
    super(message, options);
    this.errorCode = options?.errorCode;
  }

  /**
   * Create an execution error for statement failure.
   * @param errorMessage Human-readable error from the warehouse / SDK.
   * @param errorCode Structured code (e.g. "INVALID_PARAMETER_VALUE") to
   *   preserve through wrapping. Optional.
   */
  static statementFailed(
    errorMessage?: string,
    errorCode?: string,
  ): ExecutionError {
    const message = errorMessage
      ? `Statement failed: ${errorMessage}`
      : "Statement failed: Unknown error";
    return new ExecutionError(message, { errorCode });
  }

  /**
   * Create an execution error for canceled operation
   */
  static canceled(): ExecutionError {
    return new ExecutionError("Statement was canceled");
  }

  /**
   * Create an execution error for closed/expired results
   */
  static resultsClosed(): ExecutionError {
    return new ExecutionError(
      "Statement execution completed but results are no longer available (CLOSED state)",
    );
  }

  /**
   * Create an execution error for unknown state
   */
  static unknownState(state: string): ExecutionError {
    return new ExecutionError(`Unknown statement state: ${state}`, {
      context: { state },
    });
  }

  /**
   * Create an execution error for missing data
   */
  static missingData(dataType: string): ExecutionError {
    return new ExecutionError(`No ${dataType} found in response`, {
      context: { dataType },
    });
  }
}
