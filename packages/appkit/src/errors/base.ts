/** Fields that should be redacted in logs/serialization for security */
const SENSITIVE_FIELD_PATTERNS = [
  /token/i,
  /password/i,
  /secret/i,
  /credential/i,
  /auth/i,
  /key$/i,
  /apikey/i,
];

/**
 * Base error class for all AppKit errors.
 * Provides a consistent structure for error handling across the framework.
 *
 * @example
 * ```typescript
 * // Catching errors by type
 * try {
 *   await lakebase.query("...");
 * } catch (e) {
 *   if (e instanceof AuthenticationError) {
 *     // Re-authenticate
 *   } else if (e instanceof ConnectionError && e.isRetryable) {
 *     // Retry with backoff
 *   }
 * }
 *
 * // Logging errors
 * console.error(error.toJSON()); // Safe for logging, sensitive values redacted
 * ```
 */
export abstract class AppKitError extends Error {
  /** Error code for programmatic error handling */
  abstract readonly code: string;

  /** HTTP status code suggestion (can be overridden) */
  abstract readonly statusCode: number;

  /** Whether this error type is generally safe to retry */
  abstract readonly isRetryable: boolean;

  /** Optional cause of the error */
  readonly cause?: Error;

  /** Additional context for the error */
  readonly context?: Record<string, unknown>;

  /**
   * Client-safe error message. When set, callers serializing the error to
   * a client (SSE, HTTP body) MUST prefer `clientMessage` over `message`
   * — `message` may contain raw upstream / SDK text including statement
   * fragments, internal object names, and correlation IDs.
   *
   * Subclasses can set this in their constructor for a fixed sanitized
   * string. When unset, `clientMessage` defaults to a generic per-code
   * string (see the getter), and the raw `message` is kept server-side
   * only.
   */
  protected readonly _clientMessage?: string;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
      clientMessage?: string;
    },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.cause = options?.cause;
    this.context = options?.context;
    this._clientMessage = options?.clientMessage;

    // Maintains proper stack trace for where the error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Sanitized message safe to forward to clients. Override in subclasses
   * if a more specific default is appropriate.
   */
  get clientMessage(): string {
    return this._clientMessage ?? "An internal error occurred";
  }

  /**
   * Convert error to JSON for logging/serialization.
   * Sensitive values in context are automatically redacted.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      isRetryable: this.isRetryable,
      context: this.sanitizeContext(this.context),
      cause: this.cause?.message,
      stack: this.stack,
    };
  }

  /**
   * Create a human-readable string representation
   */
  toString(): string {
    let str = `${this.name} [${this.code}]: ${this.message}`;
    if (this.cause) {
      str += ` (caused by: ${this.cause.message})`;
    }
    return str;
  }

  /**
   * Sanitize context by redacting sensitive field values
   */
  private sanitizeContext(
    context?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!context) return undefined;

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (this.isSensitiveField(key)) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null) {
        // Don't deep-sanitize nested objects, just indicate their type
        sanitized[key] = Array.isArray(value)
          ? `[Array(${value.length})]`
          : "[Object]";
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /**
   * Check if a field name matches sensitive patterns
   */
  private isSensitiveField(fieldName: string): boolean {
    return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName));
  }
}
