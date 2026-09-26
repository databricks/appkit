/** Stable failure category a generated database route answers with. */
export type DatabaseErrorCategory =
  | "INVALID_REQUEST"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "TRANSIENT"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL"
  | "SETUP_FAILED";

/** Which request field a rejection concerns; it never carries caller values. */
export interface DatabaseErrorDetail {
  readonly path: readonly string[];
  readonly message: string;
}

/**
 * The one status vocabulary both sides of a generated route read. Both 500
 * categories share a status, so a status alone never claims a setup failure.
 */
const categoryByStatus: Readonly<Record<number, DatabaseErrorCategory>> = {
  400: "INVALID_REQUEST",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "VALIDATION_FAILED",
  503: "TRANSIENT",
};

/** Read a status back into its category; an unlisted status is `INTERNAL`. */
export function databaseErrorCategoryForStatus(
  status: number,
): DatabaseErrorCategory {
  return categoryByStatus[status] ?? "INTERNAL";
}
