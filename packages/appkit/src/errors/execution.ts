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
  /**
   * Stable code carried by errors created via {@link ExecutionError.canceled}.
   * Lets consumers detect cancellation programmatically without inspecting
   * the message (which may be masked in production).
   */
  static readonly CANCELED_CODE = "EXECUTION_CANCELED";

  readonly code: string;
  readonly statusCode = 500;
  readonly isRetryable = false;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
      /** Stable machine-readable code (defaults to `"EXECUTION_ERROR"`). */
      code?: string;
    },
  ) {
    super(message, options);
    this.code = options?.code ?? "EXECUTION_ERROR";
  }

  /**
   * Create an execution error for statement failure
   */
  static statementFailed(errorMessage?: string): ExecutionError {
    const message = errorMessage
      ? `Statement failed: ${errorMessage}`
      : "Statement failed: Unknown error";
    return new ExecutionError(message);
  }

  /**
   * Create an execution error for canceled operation.
   * Carries the {@link ExecutionError.CANCELED_CODE} code so cancellation
   * stays distinguishable even when the message is masked in production.
   */
  static canceled(): ExecutionError {
    return new ExecutionError("Statement was canceled", {
      code: ExecutionError.CANCELED_CODE,
    });
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
