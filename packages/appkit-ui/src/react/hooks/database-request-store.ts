import { requestDatabase } from "@/js/database/client";
import { DatabaseApiError } from "@/js/database/errors";
import type { DatabaseEntity } from "@/js/database/types";

import { createRequestStore, type RequestRunner } from "./request-store";

/**
 * Which mounted reads to restart after a write: `true` for every database
 * read, an entity list for reads of those entities only, `false` for none.
 */
export type DatabaseInvalidation = boolean | readonly DatabaseEntity[];

/**
 * Shared in-flight read store for the database hooks: an instance of the
 * generic {@link createRequestStore} lifecycle wired to the database client's
 * transport. Hook instances that resolve to the same route and encoded query
 * share one request and one snapshot while any of them is mounted.
 *
 * Nothing outlives its last subscriber, so this deduplicates reads; it is not
 * a cache.
 */

/** Immutable per-key read state; mirrors the hooks' public result shape. */
interface DatabaseReadSnapshot {
  data: unknown;
  loading: boolean;
  error: DatabaseApiError | null;
}

/** Snapshot for keys with no live entry. Referentially stable. */
export const IDLE_DATABASE_READ: DatabaseReadSnapshot = {
  data: null,
  loading: false,
  error: null,
};

/** Checks a decoded body is the envelope the read's route answers with. */
type ResponseGuard = (body: unknown) => body is object;

/**
 * Identity of one read. The resolved URL already carries the route and the
 * encoded query; the entity prefix lets a write find the reads rooted at it.
 * Entity names never contain a space, so the prefix always splits cleanly.
 */
export function databaseReadKey(entity: string, url: string): string {
  return `${entity} ${url}`;
}

/** The entity a read key is rooted at. */
function readKeyEntity(key: string): string {
  return key.slice(0, key.indexOf(" "));
}

/** Anything a request rejects with other than an abort, as the hooks report it. */
export function asDatabaseApiError(error: unknown): DatabaseApiError {
  if (error instanceof DatabaseApiError) return error;
  return new DatabaseApiError(
    "INTERNAL",
    null,
    error instanceof Error ? error.message : "Database request failed",
    [],
    { cause: error },
  );
}

/**
 * Build the runner for one read. A restart keeps the last result visible
 * while it loads, and a run superseded by a restart or torn down after its
 * last release never patches the entry.
 */
function runDatabaseRead(
  url: string,
  accept: ResponseGuard,
): RequestRunner<DatabaseReadSnapshot> {
  return ({ signal, patch }) => {
    patch({ loading: true, error: null });
    requestDatabase(url, { method: "GET", signal }, accept).then(
      (data) => {
        if (!signal.aborted) patch({ data, loading: false, error: null });
      },
      (error: unknown) => {
        if (!signal.aborted) {
          patch({ loading: false, error: asDatabaseApiError(error) });
        }
      },
    );
  };
}

const store = createRequestStore<DatabaseReadSnapshot>(IDLE_DATABASE_READ);

/**
 * Register a subscriber for `key`, starting the shared read of `url` on first
 * use. Returns a `release` function that must be called on unmount.
 */
export function retainDatabaseRead(
  key: string,
  url: string,
  accept: ResponseGuard,
): () => void {
  return store.retain(key, runDatabaseRead(url, accept));
}

/**
 * Restart mounted database reads after a write the hooks did not make, such
 * as a `databaseApi` call or a custom route that changes rows. The write hooks
 * call this on success with their `invalidate` option.
 *
 * `true` (the default) restarts every read, an entity list restarts the reads
 * rooted at those entities, and `false` restarts none. An include is invisible
 * at runtime, so a `boards` read that includes `notes` is rooted at `boards`;
 * only `true` is sure to reach it.
 *
 * @example
 * ```ts
 * await fetch(`/api/cases/${id}/sar`, { method: "POST" });
 * invalidateDatabaseReads(["str_reports", "activity_log"]);
 * ```
 */
export function invalidateDatabaseReads(
  scope: DatabaseInvalidation = true,
): void {
  if (scope === false) return;
  if (scope === true) {
    store.restartStarted();
    return;
  }
  const entities = new Set<string>(scope);
  store.restartStarted((key) => entities.has(readKeyEntity(key)));
}

export const startDatabaseRead = store.start;
export const subscribeDatabaseRead = store.subscribe;
export const getDatabaseReadSnapshot = store.getSnapshot;

/** Test-only: abort every in-flight read and clear the store. */
export const resetDatabaseRequestStore = store.reset;
