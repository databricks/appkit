/**
 * API error type surfaced by the AppKit workspace client.
 *
 * Migrated services throw the modular `@databricks/sdk-core` `ApiError`, a
 * different class from the legacy `@databricks/sdk-experimental` one, with the
 * status in `httpStatusCode` and the code in `code`. To keep `instanceof
 * ApiError`, `.statusCode` and `.errorCode` working for AppKit and its
 * consumers, the exported `ApiError` matches both classes, and modular errors
 * also expose the legacy field names.
 */
import { ApiError as ModularApiError } from "@databricks/sdk-core/apierror";
import { ApiError as LegacyApiError } from "@databricks/sdk-experimental";

// Legacy-name aliases on modular errors. Setters store an own value, so call
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

export class ApiError extends LegacyApiError {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof LegacyApiError || value instanceof ModularApiError;
  }
}
