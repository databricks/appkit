import type { DatabaseErrorCategory, DatabaseErrorDetail } from "shared";

/**
 * A server category, or `NOT_EXPOSED` when the operation has no published
 * route and nothing was sent.
 */
export type DatabaseApiErrorCode = DatabaseErrorCategory | "NOT_EXPOSED";

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
