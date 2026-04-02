/**
 * Discriminated union for plugin execution results.
 *
 * Replaces the previous `T | undefined` return type on `execute()`,
 * preserving the HTTP status code and message from the original error.
 */
export type ExecutionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };
