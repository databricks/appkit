import { AppKitError } from "../errors";
import { createLogger } from "../logging/logger";

const logger = createLogger("database");

export type DatabaseErrorCategory =
  | "INVALID_REQUEST"
  | "CONFLICT"
  | "FORBIDDEN"
  | "INTERNAL"
  | "SETUP_FAILED";

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
  CONFLICT: { message: "Database conflict", statusCode: 409 },
  FORBIDDEN: { message: "Database operation forbidden", statusCode: 403 },
  INTERNAL: { message: "Database operation failed", statusCode: 500 },
  SETUP_FAILED: { message: "Database setup failed", statusCode: 500 },
};

const categoryByStatus: Readonly<Record<number, DatabaseErrorCategory>> = {
  400: "INVALID_REQUEST",
  403: "FORBIDDEN",
  409: "CONFLICT",
};

/** AppKit-facing database failure with stable metadata and no driver details. */
export class DatabasePluginError extends AppKitError {
  readonly code = "DATABASE_PLUGIN_ERROR";
  readonly isRetryable = false;
  readonly statusCode: number;

  constructor(
    readonly category: DatabaseErrorCategory,
    readonly phase: DatabaseErrorPhase,
    runtimeMessage?: string,
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
    this.name = "DatabasePluginError";
  }
}

/** Keep runtime diagnostics internal until a plugin boundary classifies them. */
export function invalidDatabaseRequest(
  runtimeMessage?: string,
): DatabasePluginError {
  return new DatabasePluginError("INVALID_REQUEST", "runtime", runtimeMessage);
}

/** Add operation context without retaining an unknown error's details. */
export function classifyDatabaseError(
  error: unknown,
  phase: DatabaseErrorPhase,
): DatabasePluginError {
  if (error instanceof DatabasePluginError) {
    return error.phase === phase
      ? error
      : new DatabasePluginError(error.category, phase);
  }
  logger.error("Unclassified database error during %s: %O", phase, error);
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
