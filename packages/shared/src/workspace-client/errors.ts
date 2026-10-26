/**
 * API error type surfaced by the AppKit workspace client.
 *
 * AppKit's own error class, with the field names AppKit and its consumers read
 * (`statusCode`, `errorCode`). The modular `@databricks/sdk-core` `ApiError`
 * keeps its status in `httpStatusCode` and its code in `code`, so it also
 * exposes the AppKit names, and `instanceof ApiError` matches it too.
 */
import { ApiError as ModularApiError } from "@databricks/sdk-core/apierror";

// AppKit-name aliases on modular errors. Setters store an own value, so call
// sites that assign `statusCode` (e.g. via Object.assign) keep working.
for (const [name, source] of [
  ["statusCode", "httpStatusCode"],
  ["errorCode", "code"],
] as const) {
  if (!Object.hasOwn(ModularApiError.prototype, name)) {
    Object.defineProperty(ModularApiError.prototype, name, {
      configurable: true,
      get(this: ModularApiError) {
        return this[source];
      },
      set(this: ModularApiError, value: unknown) {
        Object.defineProperty(this, name, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
    readonly statusCode: number,
    readonly response?: unknown,
    readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Like the legacy SDK: only 429 is retryable by status alone. */
  isRetryable(): boolean {
    return this.statusCode === 429;
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return (
      Function.prototype[Symbol.hasInstance].call(ApiError, value) ||
      value instanceof ModularApiError
    );
  }
}
