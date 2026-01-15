import { AppKitError } from "./base";

/**
 * Error thrown when input validation fails.
 * Use for invalid parameters, missing required fields, or type mismatches.
 *
 * @example
 * ```typescript
 * throw new ValidationError("Statement is required", { context: { field: "statement" } });
 * throw new ValidationError("maxPoolSize must be at least 1", { context: { value: config.maxPoolSize } });
 * ```
 */
export class ValidationError extends AppKitError {
  readonly code = "VALIDATION_ERROR";
  readonly statusCode = 400;
  readonly isRetryable = false;

  /**
   * Create a validation error for a missing required field
   */
  static missingField(fieldName: string): ValidationError {
    return new ValidationError(`Missing required field: ${fieldName}`, {
      context: { field: fieldName },
    });
  }

  /**
   * Create a validation error for an invalid field value.
   * Note: The actual value is not stored in context for security reasons.
   * Only the value's type is recorded.
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

  /**
   * Create a validation error for missing environment variables
   */
  static missingEnvVars(vars: string[]): ValidationError {
    return new ValidationError(
      `Missing required environment variables: ${vars.join(", ")}`,
      { context: { missingVars: vars } },
    );
  }
}
