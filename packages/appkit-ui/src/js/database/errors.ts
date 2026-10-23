import {
  type DatabaseErrorCategory,
  type DatabaseErrorDetail,
  DatabaseQueryEncodingError,
} from "shared";

/**
 * A server category, or a client-side outcome: `NOT_EXPOSED` for an operation
 * the server did not publish, `UNAUTHENTICATED` for a 401, `SESSION_CHANGED`
 * for a reply that belongs to an earlier session, and `OUTCOME_UNKNOWN` when a
 * write has no usable reply and may have committed.
 */
export type DatabaseApiErrorCode =
  | DatabaseErrorCategory
  | "NOT_EXPOSED"
  | "UNAUTHENTICATED"
  | "SESSION_CHANGED"
  | "OUTCOME_UNKNOWN";

/** A failed database operation call, decoded from the server's `{ error, details }`. */
export class DatabaseApiError extends Error {
  /** Stable category; branch on this rather than on `message`. */
  readonly code: DatabaseApiErrorCode;
  /** HTTP status, or `null` when no response was received. */
  readonly status: number | null;
  /** Validation details naming request fields, from local checks or the server. */
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

/** Anything a call rejects with other than an abort, as the hooks report it. */
export function asDatabaseApiError(error: unknown): DatabaseApiError {
  if (error instanceof DatabaseApiError) return error;
  return new DatabaseApiError("INTERNAL", null, "Database request failed", [], {
    cause: error,
  });
}

/** Local input failures name the input, never the values it would have sent. */
export function invalidDatabaseInput(
  message = "Database input contains an unsupported value",
): DatabaseApiError {
  return new DatabaseApiError("INVALID_REQUEST", null, message, [
    { path: ["input"], message },
  ]);
}

/** Do not echo a caller's invalid query values into the client-facing error. */
export function invalidDatabaseQuery(error?: unknown): DatabaseApiError {
  if (error instanceof DatabaseQueryEncodingError) {
    return new DatabaseApiError("INVALID_REQUEST", null, error.message, [
      { path: [error.parameter], message: error.message },
    ]);
  }
  return new DatabaseApiError(
    "INVALID_REQUEST",
    null,
    "Database query contains an unsupported value",
  );
}

/** Local write failures name the body, never the values it would have sent. */
export function invalidDatabaseWrite(
  message = "Database write contains an unsupported value",
): DatabaseApiError {
  return new DatabaseApiError("INVALID_REQUEST", null, message, [
    { path: ["body"], message },
  ]);
}
