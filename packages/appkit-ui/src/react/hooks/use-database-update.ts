import { useCallback } from "react";
import type { ExactDatabaseParams } from "shared";

import { type IdLike, updateDatabaseRow } from "@/js/database/client";
import type {
  DatabaseId,
  DatabaseKeyedEntity,
  DatabaseRow,
  DatabaseUpdate,
} from "@/js/database/types";

import {
  type DatabaseWriteOptions,
  type DatabaseWriteState,
  useDatabaseWrite,
} from "./use-database-write";

/** What {@link useDatabaseUpdate} returns. */
export interface DatabaseUpdateResult<
  K extends DatabaseKeyedEntity,
> extends DatabaseWriteState<DatabaseRow<K>> {
  /**
   * Send `PATCH /api/database/<entity>/:id` and resolve with the updated row,
   * or with `null` when the write failed; the reason is in `error`, and a
   * missing row is `NOT_FOUND`. It never rejects.
   */
  update<const V extends DatabaseUpdate<K>>(
    id: DatabaseId<K>,
    values: V & ExactDatabaseParams<V, DatabaseUpdate<K>>,
  ): Promise<DatabaseRow<K> | null>;
  /** Return to the idle state; a call in flight no longer reports here. */
  reset(): void;
}

/**
 * Update rows through `PATCH /api/database/<entity>/:id`. Only entities with a
 * public primary key have this route, and keys, generated, and
 * default-stamped columns are not updatable. Once an update succeeds, mounted
 * database reads restart.
 *
 * @param entity - A table the generated registry exposes with a public key
 * @param options - `invalidate` to narrow or turn off the read restart
 * @returns `update`, the latest call's row, loading and error state, and `reset`
 *
 * @example
 * ```tsx
 * const notes = useDatabaseUpdate("notes");
 *
 * <button onClick={() => notes.update(note.id, { body: "Resolved" })}>
 *   Resolve
 * </button>;
 * ```
 */
export function useDatabaseUpdate<K extends DatabaseKeyedEntity>(
  entity: K,
  options: DatabaseWriteOptions = {},
): DatabaseUpdateResult<K> {
  const send = useCallback(
    (id: IdLike, values: object) => updateDatabaseRow(entity, id, values),
    [entity],
  );
  const { mutate, ...write } = useDatabaseWrite(
    send,
    options.invalidate ?? true,
  );
  // The server projected the row it holds; the types describe that wire.
  return { ...write, update: mutate } as DatabaseUpdateResult<K>;
}
