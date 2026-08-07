import { AppKitError } from "../errors";
import { createLogger } from "../logging/logger";

const logger = createLogger("database");

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

type DatabaseErrorPhase =
  | "setup"
  | "shutdown"
  | "read"
  | "write"
  | "transaction"
  | "runtime";

const definitions: Record<
  DatabaseErrorCategory,
  { readonly message: string; readonly statusCode: number }
> = {
  INVALID_REQUEST: { message: "Invalid database request", statusCode: 400 },
  VALIDATION_FAILED: {
    message: "Database request failed validation",
    statusCode: 422,
  },
  NOT_FOUND: { message: "Database record not found", statusCode: 404 },
  CONFLICT: { message: "Database conflict", statusCode: 409 },
  FORBIDDEN: { message: "Database operation forbidden", statusCode: 403 },
  TRANSIENT: {
    message: "Database operation temporarily unavailable",
    statusCode: 503,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    message: "Database request body must be JSON",
    statusCode: 415,
  },
  PAYLOAD_TOO_LARGE: {
    message: "Database response is too large",
    statusCode: 413,
  },
  INTERNAL: { message: "Database operation failed", statusCode: 500 },
  SETUP_FAILED: { message: "Database setup failed", statusCode: 500 },
};

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

/** AppKit-facing database failure with stable metadata and no driver details. */
export class DatabasePluginError extends AppKitError {
  readonly code = "DATABASE_PLUGIN_ERROR";
  readonly isRetryable: boolean;
  readonly statusCode: number;

  constructor(
    readonly category: DatabaseErrorCategory,
    readonly phase: DatabaseErrorPhase,
    runtimeMessage?: string,
    readonly details?: readonly DatabaseErrorDetail[],
  ) {
    const definition = definitions[category];
    // Plugin boundaries replace runtime diagnostics with the stable message.
    super(
      phase === "runtime" && runtimeMessage
        ? runtimeMessage
        : definition.message,
      {
        clientMessage: definition.message,
      },
    );
    this.statusCode = definition.statusCode;
    this.isRetryable = category === "TRANSIENT";
    this.name = "DatabasePluginError";
  }
}

/** Keep runtime diagnostics internal until a plugin boundary classifies them. */
export function invalidDatabaseRequest(
  runtimeMessage?: string,
): DatabasePluginError {
  return new DatabasePluginError("INVALID_REQUEST", "runtime", runtimeMessage);
}

/** Refuse to publish a plugin whose configuration cannot be honored. */
export function databaseSetupFailed(): DatabasePluginError {
  return new DatabasePluginError("SETUP_FAILED", "setup");
}

/** Reject untrusted request input, naming the field but never its value. */
export function invalidDatabaseInput(
  path: readonly string[],
  message: string,
): DatabasePluginError {
  return new DatabasePluginError("INVALID_REQUEST", "read", undefined, [
    { path, message },
  ]);
}

/**
 * Name an unknown failure without its payload. A driver error carries the SQL
 * text and its bound row values (for example a `DrizzleQueryError` retains
 * `query` and `params`), so only constructor names walk into the log.
 */
function describeUnclassifiedError(error: unknown): string {
  const names: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    names.push(current.name);
    current = current.cause;
  }
  return names.length > 0 ? names.join(" <- ") : typeof error;
}

/** Add operation context without retaining an unknown error's details. */
export function classifyDatabaseError(
  error: unknown,
  phase: DatabaseErrorPhase,
): DatabasePluginError {
  if (error instanceof DatabasePluginError) {
    // Details name request fields only, so they survive a change of phase.
    return error.phase === phase
      ? error
      : new DatabasePluginError(
          error.category,
          phase,
          undefined,
          error.details,
        );
  }
  logger.error(
    "Unclassified database error during %s (%s)",
    phase,
    describeUnclassifiedError(error),
  );
  return new DatabasePluginError("INTERNAL", phase);
}

/** Restore the safe database category carried through `Plugin.execute()`. */
export function databaseErrorFromStatus(
  status: number,
  phase: DatabaseErrorPhase,
): DatabasePluginError {
  const category = categoryByStatus[status] ?? "INTERNAL";
  return new DatabasePluginError(category, phase);
}
