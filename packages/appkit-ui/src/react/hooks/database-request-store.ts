import { getPluginClientConfig } from "@/js/config";
import { requestDatabase } from "@/js/database/client";
import { DatabaseApiError } from "@/js/database/errors";
import type { DatabaseEntity } from "@/js/database/types";

import { createRequestStore, type RequestRunner } from "./request-store";

/**
 * Which mounted reads to restart after a write: `true` for every database
 * read, a table list for the reads that touch those tables, `false` for none.
 */
export type DatabaseInvalidation = boolean | readonly DatabaseEntity[];

/**
 * Shared in-flight read store for the database hooks: an instance of the
 * generic {@link createRequestStore} lifecycle wired to the database client's
 * transport. Hook instances that resolve to the same URL share one request and
 * one snapshot while any of them is mounted.
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
export const IDLE_DATABASE_READ: DatabaseReadSnapshot = Object.freeze({
  data: null,
  loading: false,
  error: null,
});

/** Checks a decoded body is the envelope the read's route answers with. */
type ResponseGuard = (body: unknown) => body is object;

/**
 * The tables one read shows rows of: the one it is rooted at and every table
 * its includes reach. `open` marks a read with an include the server did not
 * describe, which any scoped invalidation restarts rather than risk missing.
 */
export interface DatabaseReadScope {
  readonly tables: ReadonlySet<string>;
  readonly open: boolean;
}

/** `{ table: { relation: targetTable } }`, as `DatabasePlugin` publishes it. */
type PublishedRelations = Record<string, Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publishedRelations(): PublishedRelations {
  const { relations } = getPluginClientConfig<{ relations?: unknown }>(
    "database",
  );
  return isRecord(relations) ? (relations as PublishedRelations) : {};
}

/**
 * Walk a read's include tree through the relations the server published, so
 * a write to `notes` can find a `boards` read that includes its notes.
 */
export function databaseReadScope(
  entity: string,
  include: unknown,
): DatabaseReadScope {
  const relations = publishedRelations();
  const tables = new Set<string>([entity]);
  let open = false;

  const walk = (table: string, tree: unknown): void => {
    if (!isRecord(tree)) return;
    const edges = relations[table];
    for (const [name, options] of Object.entries(tree)) {
      const target =
        isRecord(edges) && Object.hasOwn(edges, name) ? edges[name] : undefined;
      if (typeof target !== "string") {
        open = true;
        continue;
      }
      tables.add(target);
      if (isRecord(options)) walk(target, options.include);
    }
  };
  walk(entity, include);

  return { tables, open };
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

/** Resolves once `signal` aborts, even if the transport ignores it. */
function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Build the runner for one read. A restart keeps the last result visible
 * while it loads, and a run superseded by a restart or torn down after its
 * last release never patches the entry. A `NOT_FOUND` drops the last result:
 * the row is gone, so showing it beside the error would mislead. The returned
 * promise settles once the run has patched its outcome or was aborted.
 */
function runDatabaseRead(
  url: string,
  accept: ResponseGuard,
): RequestRunner<DatabaseReadSnapshot> {
  return ({ signal, patch }) => {
    patch({ loading: true, error: null });
    const outcome = requestDatabase(
      url,
      { method: "GET", signal },
      accept,
    ).then(
      (data) => {
        if (!signal.aborted) patch({ data, loading: false, error: null });
      },
      (cause: unknown) => {
        if (signal.aborted) return;
        const error = asDatabaseApiError(cause);
        patch(
          error.code === "NOT_FOUND"
            ? { data: null, loading: false, error }
            : { loading: false, error },
        );
      },
    );
    return Promise.race([outcome, whenAborted(signal)]);
  };
}

const store = createRequestStore<DatabaseReadSnapshot, DatabaseReadScope>(
  IDLE_DATABASE_READ,
);

/**
 * Register a subscriber for the read of `url`, starting it on first use.
 * `scope` is kept from the first subscriber; it is derived from the same
 * params as `url`, so every subscriber of one URL has the same scope.
 * Returns a `release` function that must be called on unmount.
 */
export function retainDatabaseRead(
  url: string,
  accept: ResponseGuard,
  scope: DatabaseReadScope,
): () => void {
  return store.retain(url, runDatabaseRead(url, accept), { meta: scope });
}

/**
 * Restart mounted database reads after a write the hooks did not make, such
 * as a `databaseApi` call or a custom route that changes rows. The write hooks
 * call this on success with their `invalidate` option.
 *
 * `true` (the default) restarts every read. A table list restarts the reads
 * that show rows of those tables: reads rooted at them, and reads whose
 * includes reach them through the relations the server published. `false`
 * restarts none.
 *
 * Resolves once the current runs of those reads have answered, failed, or
 * been torn down. A superseding refresh is followed rather than counted as
 * complete; it never rejects.
 *
 * @example
 * ```ts
 * await fetch(`/api/boards/${boardId}/archive`, { method: "POST" });
 * await invalidateDatabaseReads(["boards", "notes"]);
 * ```
 */
export function invalidateDatabaseReads(
  scope: DatabaseInvalidation = true,
): Promise<void> {
  if (scope === false) return Promise.resolve();
  if (scope === true) return store.restartStarted();
  const written = new Set<string>(scope);
  if (written.size === 0) return Promise.resolve();
  return store.restartStarted((_url, read) => {
    if (read === undefined || read.open) return true;
    for (const table of read.tables) if (written.has(table)) return true;
    return false;
  });
}

export const startDatabaseRead = store.start;
export const subscribeDatabaseRead = store.subscribe;
export const getDatabaseReadSnapshot = store.getSnapshot;

/** Test-only: abort every in-flight read and clear the store. */
export const resetDatabaseRequestStore = store.reset;
