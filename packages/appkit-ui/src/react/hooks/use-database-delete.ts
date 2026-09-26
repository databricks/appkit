import { useCallback } from "react";

import { deleteDatabaseRow, type IdLike } from "@/js/database/client";
import type { DatabaseApiError } from "@/js/database/errors";
import type { DatabaseId, DatabaseKeyedEntity } from "@/js/database/types";

import {
  type DatabaseWriteOptions,
  useDatabaseWrite,
} from "./use-database-write";

/** What {@link useDatabaseDelete} returns. */
export interface DatabaseDeleteResult<K extends DatabaseKeyedEntity> {
  /**
   * Send `DELETE /api/database/<entity>/:id` and resolve `true` once the row
   * is deleted, or `false` when the write failed; the reason is in `error`,
   * and a missing row is `NOT_FOUND`. It never rejects.
   */
  remove(id: DatabaseId<K>): Promise<boolean>;
  /** Whether the latest call is in flight. */
  loading: boolean;
  /** Why the latest call failed; `NOT_EXPOSED` when no route exists. */
  error: DatabaseApiError | null;
  /** Return to the idle state; a call in flight no longer reports here. */
  reset(): void;
}

/**
 * Delete rows through `DELETE /api/database/<entity>/:id`. Only entities with
 * a public primary key have this route. Once a delete succeeds, mounted
 * database reads restart, so lists that showed the row drop it.
 *
 * @param entity - A table the generated registry exposes with a public key
 * @param options - `invalidate` to narrow or turn off the read restart
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
  options: DatabaseWriteOptions = {},
): DatabaseDeleteResult<K> {
  // A delete answers no row, so success is the only result worth reporting.
  const send = useCallback(
    async (id: IdLike) => {
      await deleteDatabaseRow(entity, id);
      return true as const;
    },
    [entity],
  );
  const { mutate, reset, loading, error } = useDatabaseWrite(
    send,
    options.invalidate ?? true,
  );
  const remove = useCallback(
    async (id: DatabaseId<K>) => (await mutate(id)) === true,
    [mutate],
  );
  return { remove, reset, loading, error };
}
