import type { DatabaseErrorCategory, DatabaseErrorDetail } from "shared";

/**
 * A server category, `NOT_EXPOSED` for unpublished routes, or
 * `OUTCOME_UNKNOWN` when a write has no response and may have committed.
 */
export type DatabaseApiErrorCode =
  | DatabaseErrorCategory
  | "NOT_EXPOSED"
  | "OUTCOME_UNKNOWN";

/** A failed database request, decoded from the generated `{ error, details }`. */
export class DatabaseApiError extends Error {
  /** Stable category; branch on this rather than on `message`. */
  readonly code: DatabaseApiErrorCode;
  /** HTTP status, or `null` when no response was received. */
  readonly status: number | null;
  /** Validation details naming public request fields, when the server sent any. */
  readonly details: readonly DatabaseErrorDetail[];

  constructor(
    code: DatabaseApiErrorCode,
    status: number | null,
    message: string,
    details: readonly DatabaseErrorDetail[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DatabaseApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Do not echo a caller's invalid query values into the client-facing error. */
export function invalidDatabaseQuery(): DatabaseApiError {
  return new DatabaseApiError(
    "INVALID_REQUEST",
    null,
    "Database query contains an unsupported value",
  );
}
