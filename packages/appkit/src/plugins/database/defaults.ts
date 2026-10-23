import type { PluginExecuteConfig } from "shared";

/** Default interceptor policy for bounded reads. */
export const databaseReadDefaults: PluginExecuteConfig = {
  retry: { enabled: false },
};

/** Default interceptor policy for mutations. */
export const databaseWriteDefaults: PluginExecuteConfig = {
  cache: { enabled: false },
  retry: { enabled: false },
};

// Connection posture: how long any one statement may hold a pooled connection.
/**
 * Server-side `statement_timeout` applied to every pooled connection (ms).
 * PostgreSQL cancels the statement itself, so an expensive caller-supplied
 * filter (for example a leading-wildcard `ilike`) cannot hold its pooled
 * connection past the deadline.
 */
export const STATEMENT_TIMEOUT_MS = 30_000;

/** Server-side limit for an idle open transaction, independent of JS timers (ms). */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

/** Deadline for one explicit transaction callback (ms). */
export const TRANSACTION_TIMEOUT_MS = 30_000;

// Operation request limits, enforced before any database work is scheduled.
/** Max encoded size of one operation's GET query string. */
export const MAX_QUERY_BYTES = 8 * 1024;
/** Max UTF-8 size of one operation request body. */
export const MAX_OPERATION_BODY_BYTES = 1024 * 1024;

/** Max nesting depth of one bounded JSON value. */
export const MAX_SERIALIZED_DEPTH = 32;
/** Max node count of one bounded JSON value. */
export const MAX_SERIALIZED_NODES = 10_000;
/** Max UTF-8 byte length of one operation response body. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
