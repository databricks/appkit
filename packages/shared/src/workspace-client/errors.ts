/**
 * API error type surfaced by the AppKit workspace client.
 *
 * Re-exports the legacy `@databricks/sdk-experimental` `ApiError` so AppKit
 * catch sites (`instanceof ApiError`, `.statusCode`) and the one construction
 * site in `connectors/files/client.ts` keep working unchanged while importing
 * from the wrapper instead of the SDK.
 *
 * When the first modular service lands (throwing `@databricks/sdk-core`'s
 * distinct `ApiError`), add an `isApiError(e)` / `getApiErrorStatusCode(e)`
 * predicate here to unify the two shapes — `instanceof` can't, since they're
 * classes from different packages.
 */
export { ApiError } from "@databricks/sdk-experimental";
