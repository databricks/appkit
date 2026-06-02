/**
 * Error types surfaced by the AppKit workspace client.
 *
 * The wrapper bridges TWO different `ApiError` classes during the
 * migration window:
 *
 *   1. **Legacy** `ApiError` from `@databricks/sdk-experimental` —
 *      thrown by services still delegated to the legacy SDK
 *      (`statementExecution`, `servingEndpoints`, `currentUser`,
 *      `genie`, `jobs`) AND by `@databricks/lakebase`. Has
 *      `error.statusCode: number` (always present).
 *
 *   2. **Modular** `ApiError` from `@databricks/sdk-core/apierror` —
 *      thrown by the modular service clients we wired (`files`,
 *      `warehouses`, `vectorSearch`) and by `wrapper.http.request(...)`
 *      via the new SDK transport. Has `error.httpStatusCode: number`
 *      (getter; `-1` if not an HTTP error) and structured
 *      `code`/`details`.
 *
 * `instanceof` won't unify them — they're distinct classes from
 * distinct packages. Use `isApiError(err)` and `getApiErrorStatusCode(err)`
 * below at every catch site.
 *
 * The exported `ApiError` symbol points at the **legacy** class so
 * existing `error instanceof ApiError` checks keep matching legacy
 * errors. New checks should prefer the predicate.
 *
 * TODO(prod): once everything migrates to the modular SDK (lakebase
 * included), collapse this to just `@databricks/sdk-core/apierror` and
 * delete the predicate.
 */
import { ApiError as ModularApiError } from "@databricks/sdk-core/apierror";
import { ApiError as LegacyApiError } from "@databricks/sdk-experimental";

/**
 * Backwards-compatible export: the legacy `ApiError` class. Preserves
 * `instanceof ApiError` against errors thrown via the legacy SDK and via
 * `@databricks/lakebase` (which still uses the legacy SDK). For errors
 * from the modular service clients, prefer {@link isApiError}.
 */
export { ApiError } from "@databricks/sdk-experimental";

/**
 * True if `err` is a Databricks SDK API error from EITHER the modular
 * `@databricks/sdk-core/apierror` `ApiError` OR the legacy
 * `@databricks/sdk-experimental` `ApiError`. Replaces ad-hoc
 * `error instanceof ApiError` checks at the boundary between AppKit and
 * the SDK.
 */
export function isApiError(
  err: unknown,
): err is LegacyApiError | ModularApiError {
  return err instanceof LegacyApiError || err instanceof ModularApiError;
}

/**
 * Returns the HTTP status code for an SDK error from either SDK shape,
 * or `undefined` if `err` is not a recognized SDK error.
 *
 * - Legacy SDK: reads `error.statusCode`.
 * - Modular SDK: reads `error.httpStatusCode` (returns `undefined` if it's
 *   the sentinel `-1`, which means the error wasn't HTTP-shaped).
 */
export function getApiErrorStatusCode(err: unknown): number | undefined {
  if (err instanceof LegacyApiError) {
    return err.statusCode;
  }
  if (err instanceof ModularApiError) {
    const code = err.httpStatusCode;
    return code === -1 ? undefined : code;
  }
  return undefined;
}
