import { AppKitError } from "./base";

/**
 * Error thrown when a connection or network operation fails.
 * Use for database pool errors, API failures, timeouts, etc.
 *
 * @example
 * ```typescript
 * throw new ConnectionError("Query failed", { cause: pgError });
 * throw new ConnectionError("No response received from SQL Warehouse API");
 * ```
 */
export class ConnectionError extends AppKitError {
  readonly code = "CONNECTION_ERROR";
  readonly statusCode = 503;
  readonly isRetryable = true;

  /**
   * Create a connection error for query failure
   */
  static queryFailed(cause?: Error): ConnectionError {
    return new ConnectionError("Query failed", { cause });
  }

  /**
   * Create a connection error for transaction failure
   */
  static transactionFailed(cause?: Error): ConnectionError {
    return new ConnectionError("Transaction failed", { cause });
  }

  /**
   * Create a connection error for pool errors
   */
  static poolError(operation: string, cause?: Error): ConnectionError {
    return new ConnectionError(`Connection pool error: ${operation}`, {
      cause,
    });
  }

  /**
   * Create a connection error for API failures
   */
  static apiFailure(service: string, cause?: Error): ConnectionError {
    return new ConnectionError(`No response received from ${service} API`, {
      cause,
      context: { service },
    });
  }

  /**
   * Create a connection error for client unavailable
   */
  static clientUnavailable(clientType: string, hint?: string): ConnectionError {
    const message = hint
      ? `${clientType} not available. ${hint}`
      : `${clientType} not available`;
    return new ConnectionError(message, { context: { clientType } });
  }
}
