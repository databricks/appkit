/**
 * Discriminated union for plugin execution results.
 *
 * Replaces the previous `T | undefined` return type on `execute()`.
 *
 * On failure, the HTTP status code is preserved from:
 * - `AppKitError` subclasses (via `statusCode`)
 * - Any `Error` with a numeric `statusCode` property (e.g. `ApiError`)
 * - All other errors default to status 500
 *
 * In production, error messages from non-AppKitError sources are handled as:
 * - 4xx errors: original message is preserved (client-facing by design)
 * - 5xx errors: replaced with "Server error" to prevent information leakage
 */
export type ExecutionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; readonly error?: unknown };

/** Keep the original failure for internal callers without serializing it. */
export function executionFailure(
  error: unknown,
  status: number,
  message: string,
): ExecutionResult<never> {
  return Object.defineProperty(
    { ok: false as const, status, message },
    "error",
    {
      value: error,
      enumerable: false,
    },
  );
}
