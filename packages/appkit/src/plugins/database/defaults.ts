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

/** Deadline for the transaction callback, not cancellation of arbitrary hook work (ms). */
export const TRANSACTION_TIMEOUT_MS = 30_000;

// Generated-read limits. The wire caps a typed caller shares with HTTP live in
// `database/contract`; these bound only what an untrusted request may ask for.

// Request decoding: rejected before any database work is scheduled.
/** Max encoded size of a generated read query string. */
export const MAX_QUERY_BYTES = 8 * 1024;
/** Max nesting depth of `and`/`or` groups in one generated filter. */
export const MAX_WHERE_DEPTH = 5;
/** Max column conditions across one generated filter. */
export const MAX_WHERE_CONDITIONS = 50;
/** Max members in one `and`/`or` group. */
export const MAX_GROUP_ITEMS = 20;
/** Max columns one generated `order` may name. */
export const MAX_ORDER_FIELDS = 10;
/** Max accepted generated `offset`. */
export const MAX_OFFSET = 10_000;
/** Max rows one generated read may materialize across its include tree. */
export const MAX_MATERIALIZED_NODES = 10_000;

// Response shaping: bounds trusted output on its way to the wire.
/** Max nesting depth of read-serializer output. */
export const MAX_SERIALIZED_DEPTH = 32;
/** Max node count of read-serializer output. */
export const MAX_SERIALIZED_NODES = 10_000;
/** Max UTF-8 byte length of one generated read response body. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
