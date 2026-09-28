import { useCallback } from "react";
import type { ExactDatabaseParams } from "shared";

import { updateDatabaseRow } from "@/js/database/client";
import type { DatabaseApiError } from "@/js/database/errors";
import type {
  DatabaseId,
  DatabaseKeyedEntity,
  DatabaseRow,
  DatabaseUpdate,
} from "@/js/database/types";

import {
  type UseDatabaseWriteOptions,
  type UseDatabaseWriteState,
  useDatabaseWrite,
} from "./use-database-write";

/** Options for {@link useDatabaseUpdate}. */
export interface UseDatabaseUpdateOptions<
  K extends DatabaseKeyedEntity,
> extends UseDatabaseWriteOptions {
  /**
   * Called for every successful update, once the restarted reads reloaded,
   * even if the component unmounted meanwhile.
   */
  onSuccess?: (
    row: DatabaseRow<K>,
    id: DatabaseId<K>,
    values: DatabaseUpdate<K>,
  ) => void;
  /** Called for every failed update, with the error `error` also reports. */
  onError?: (
    error: DatabaseApiError,
    id: DatabaseId<K>,
    values: DatabaseUpdate<K>,
  ) => void;
}

/** What {@link useDatabaseUpdate} returns. */
export interface UseDatabaseUpdateResult<
  K extends DatabaseKeyedEntity,
> extends UseDatabaseWriteState<DatabaseRow<K>> {
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
 * @param options - `invalidate` to narrow the read restart; `onSuccess` and
 *   `onError` to observe every call
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
  options: UseDatabaseUpdateOptions<K> = {},
): UseDatabaseUpdateResult<K> {
  const send = useCallback(
    (id: DatabaseId<K>, values: DatabaseUpdate<K>) =>
      updateDatabaseRow(entity, id, values as object),
    [entity],
  );
  const { onSuccess, onError } = options;
  const { mutate, ...write } = useDatabaseWrite(send, {
    invalidate: options.invalidate,
    // The server projected the row it holds; the types describe that wire.
    onSuccess:
      onSuccess &&
      ((row, [id, values]) => onSuccess(row as DatabaseRow<K>, id, values)),
    onError: onError && ((error, [id, values]) => onError(error, id, values)),
  });
  return { ...write, update: mutate } as UseDatabaseUpdateResult<K>;
}
