import { AppKitError } from "./base";

/**
 * Error thrown when configuration is missing or invalid.
 * Use for missing environment variables, invalid settings, or setup issues.
 *
 * @example
 * ```typescript
 * throw new ConfigurationError("DATABRICKS_HOST environment variable is required");
 * throw new ConfigurationError("Warehouse ID not found", { context: { env: "production" } });
 * ```
 */
export class ConfigurationError extends AppKitError {
  readonly code = "CONFIGURATION_ERROR";
  readonly statusCode = 500;
  readonly isRetryable = false;

  /**
   * Create a configuration error for missing environment variable
   */
  static missingEnvVar(varName: string): ConfigurationError {
    return new ConfigurationError(
      `${varName} environment variable is required`,
      { context: { envVar: varName } },
    );
  }

  /**
   * Create a configuration error for missing resource
   */
  static resourceNotFound(resource: string, hint?: string): ConfigurationError {
    const message = hint
      ? `${resource} not found. ${hint}`
      : `${resource} not found`;
    return new ConfigurationError(message, { context: { resource } });
  }

  /**
   * Create a configuration error for invalid connection config
   */
  static invalidConnection(
    service: string,
    details?: string,
  ): ConfigurationError {
    const message = details
      ? `${service} connection not configured. ${details}`
      : `${service} connection not configured`;
    return new ConfigurationError(message, { context: { service } });
  }

  /**
   * Create a configuration error for missing connection string parameter
   */
  static missingConnectionParam(param: string): ConfigurationError {
    return new ConfigurationError(
      `Connection string must include ${param} parameter`,
      { context: { parameter: param } },
    );
  }
}
