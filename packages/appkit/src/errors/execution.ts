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
      clientMessage?: string;
    },
  ) {
    super(message, options);
    this.errorCode = options?.errorCode;
  }

  /**
   * Execution errors default to a generic message — the raw warehouse /
   * SDK text in `.message` often includes statement fragments, internal
   * paths, and correlation IDs. UI code should branch on `errorCode`
   * (`INLINE_ARROW_STASH_EXHAUSTED`, `NOT_IMPLEMENTED`, etc.) and not on
   * the human string.
   */
  override get clientMessage(): string {
    return this._clientMessage ?? "Query execution failed";
  }

  /**
   * Create an execution error for statement failure.
   * @param errorMessage Human-readable error from the warehouse / SDK.
   *   Goes into `.message` for server logs only — *never* echoed to the
   *   client. Pass `clientMessage` explicitly if a sanitized text should
   *   reach the UI.
   * @param errorCode Structured code (e.g. "INVALID_PARAMETER_VALUE") to
   *   preserve through wrapping. Optional. Forwarded on SSE error
   *   payloads so UI can branch on it instead of substring-matching
   *   `error`.
   * @param clientMessage Optional client-safe replacement for `.message`.
   *   Defaults to "Query execution failed" via the `clientMessage`
   *   getter. Set this only when the upstream text is known-safe.
   */
  static statementFailed(
    errorMessage?: string,
    errorCode?: string,
    clientMessage?: string,
  ): ExecutionError {
    const message = errorMessage
      ? `Statement failed: ${errorMessage}`
      : "Statement failed: Unknown error";
    return new ExecutionError(message, { errorCode, clientMessage });
  }

  /**
   * Create an execution error for canceled operation
   */
  static canceled(): ExecutionError {
    return new ExecutionError("Statement was canceled", {
      clientMessage: "Query was canceled",
    });
  }

  /**
   * Create an execution error for closed/expired results
   */
  static resultsClosed(): ExecutionError {
    return new ExecutionError(
      "Statement execution completed but results are no longer available (CLOSED state)",
      { clientMessage: "Query results expired" },
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

  /**
   * Create an execution error for the inline Arrow stash being unable to
   * accept a payload (both regular and overflow pools at cap).
   *
   * The route deliberately surfaces this rather than silently re-running
   * the statement on EXTERNAL_LINKS — a second execution can be billed
   * and return divergent results for non-deterministic SQL. Operators
   * should tune stash capacity or back off load when this fires.
   */
  static stashExhausted(): ExecutionError {
    return new ExecutionError(
      "Inline Arrow stash exhausted; retry shortly or increase stash capacity",
      {
        errorCode: "INLINE_ARROW_STASH_EXHAUSTED",
        clientMessage: "Server is at capacity, please retry",
      },
    );
  }
}
