import { AppKitError } from "./base";

/**
 * Error thrown when a service or component is not properly initialized.
 * Use when accessing services before they are ready.
 *
 * @example
 * ```typescript
 * throw new InitializationError("CacheManager not initialized");
 * throw new InitializationError("ServiceContext not initialized. Call ServiceContext.initialize() first.");
 * ```
 */
export class InitializationError extends AppKitError {
  readonly code = "INITIALIZATION_ERROR";
  readonly statusCode = 500;
  readonly isRetryable = true;

  /**
   * Create an initialization error for a service that is not ready
   */
  static notInitialized(
    serviceName: string,
    hint?: string,
  ): InitializationError {
    const message = hint
      ? `${serviceName} not initialized. ${hint}`
      : `${serviceName} not initialized`;
    return new InitializationError(message, {
      context: { service: serviceName },
    });
  }

  /**
   * Create an initialization error for setup failure
   */
  static setupFailed(component: string, cause?: Error): InitializationError {
    return new InitializationError(`Failed to initialize ${component}`, {
      cause,
      context: { component },
    });
  }

  /**
   * Create an initialization error for migration failure
   */
  static migrationFailed(cause?: Error): InitializationError {
    return new InitializationError(
      "Error in running migrations for persistent storage",
      { cause },
    );
  }
}
