import { useCallback } from "react";

import { deleteDatabaseRow } from "@/js/database/client";
import type { DatabaseApiError } from "@/js/database/errors";
import type { DatabaseId, DatabaseKeyedEntity } from "@/js/database/types";

import {
  type UseDatabaseWriteOptions,
  type UseDatabaseWriteState,
  useDatabaseWrite,
} from "./use-database-write";

/** Options for {@link useDatabaseDelete}. */
export interface UseDatabaseDeleteOptions<
  K extends DatabaseKeyedEntity,
> extends UseDatabaseWriteOptions {
  /**
   * Called for every successful delete, once the restarted reads reloaded,
   * even if the component unmounted meanwhile.
   */
  onSuccess?: (id: DatabaseId<K>) => void;
  /** Called for every failed delete, with the error `error` also reports. */
  onError?: (error: DatabaseApiError, id: DatabaseId<K>) => void;
}

/** What {@link useDatabaseDelete} returns. A delete answers no row. */
export interface UseDatabaseDeleteResult<
  K extends DatabaseKeyedEntity,
> extends Omit<UseDatabaseWriteState<never>, "data"> {
  /**
   * Send `DELETE /api/database/<entity>/:id` and resolve `true` once the row
   * is deleted, or `false` when the write failed; the reason is in `error`,
   * and a missing row is `NOT_FOUND`. It never rejects.
   */
  remove(id: DatabaseId<K>): Promise<boolean>;
  /** Return to the idle state; a call in flight no longer reports here. */
  reset(): void;
}

/**
 * Delete rows through `DELETE /api/database/<entity>/:id`. Only entities with
 * a public primary key have this route. Once a delete succeeds, mounted
 * database reads restart, so lists that showed the row drop it and a record
 * read of it reports `NOT_FOUND` with no `data`.
 *
 * @param entity - A table the generated registry exposes with a public key
 * @param options - `invalidate` to narrow the read restart; `onSuccess` and
 *   `onError` to observe every call
 * @returns `remove`, loading and error state, and `reset`
 *
 * @example
 * ```tsx
 * const notes = useDatabaseDelete("notes");
 *
 * <button disabled={notes.loading} onClick={() => notes.remove(note.id)}>
 *   Delete
 * </button>;
 * ```
 */
export function useDatabaseDelete<K extends DatabaseKeyedEntity>(
  entity: K,
  options: UseDatabaseDeleteOptions<K> = {},
): UseDatabaseDeleteResult<K> {
  // A delete answers no row, so success is the only result worth reporting.
  const send = useCallback(
    async (id: DatabaseId<K>) => {
      await deleteDatabaseRow(entity, id);
      return true as const;
    },
    [entity],
  );
  const { onSuccess, onError } = options;
  const { mutate, reset, loading, error } = useDatabaseWrite(send, {
    invalidate: options.invalidate,
    onSuccess: onSuccess && ((_deleted, [id]) => onSuccess(id)),
    onError: onError && ((failure, [id]) => onError(failure, id)),
  });
  const remove = useCallback(
    async (id: DatabaseId<K>) => (await mutate(id)) === true,
    [mutate],
  );
  return { remove, reset, loading, error };
}
