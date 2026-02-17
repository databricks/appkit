/**
 * Base error class for Lakebase driver errors.
 */
export abstract class LakebaseError extends Error {
  abstract readonly code: string;
  readonly cause?: Error;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    options?: { cause?: Error; context?: Record<string, unknown> },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.cause = options?.cause;
    this.context = options?.context;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when configuration is missing or invalid.
 */
export class ConfigurationError extends LakebaseError {
  readonly code = "CONFIGURATION_ERROR";

  /**
   * Create a configuration error for missing environment variable
   */
  static missingEnvVar(varName: string): ConfigurationError {
    return new ConfigurationError(
      `${varName} environment variable is required`,
      { context: { envVar: varName } },
    );
  }
}

/**
 * Error thrown when input validation fails.
 */
export class ValidationError extends LakebaseError {
  readonly code = "VALIDATION_ERROR";

  /**
   * Create a validation error for an invalid field value
   */
  static invalidValue(
    fieldName: string,
    value: unknown,
    expected?: string,
  ): ValidationError {
    const msg = expected
      ? `Invalid value for ${fieldName}: expected ${expected}`
      : `Invalid value for ${fieldName}`;
    return new ValidationError(msg, {
      context: {
        field: fieldName,
        valueType: value === null ? "null" : typeof value,
        expected,
      },
    });
  }
}
