import { useCallback } from "react";
import type { ExactDatabaseParams } from "shared";

import { createDatabaseRow } from "@/js/database/client";
import type { DatabaseApiError } from "@/js/database/errors";
import type {
  DatabaseEntity,
  DatabaseInsert,
  DatabaseRow,
} from "@/js/database/types";

import {
  type UseDatabaseWriteOptions,
  type UseDatabaseWriteState,
  useDatabaseWrite,
} from "./use-database-write";

/** Options for {@link useDatabaseCreate}. */
export interface UseDatabaseCreateOptions<
  K extends DatabaseEntity,
> extends UseDatabaseWriteOptions {
  /**
   * Called for every successful create, once the restarted reads reloaded,
   * even if the component unmounted meanwhile.
   */
  onSuccess?: (row: DatabaseRow<K>, values: DatabaseInsert<K>) => void;
  /** Called for every failed create, with the error `error` also reports. */
  onError?: (error: DatabaseApiError, values: DatabaseInsert<K>) => void;
}

/** What {@link useDatabaseCreate} returns. */
export interface UseDatabaseCreateResult<
  K extends DatabaseEntity,
> extends UseDatabaseWriteState<DatabaseRow<K>> {
  /**
   * Send `POST /api/database/<entity>` and resolve with the created row, or
   * with `null` when the write failed; the reason is in `error`. It never
   * rejects, so a handler needs no `try/catch`.
   */
  create<const V extends DatabaseInsert<K>>(
    values: V & ExactDatabaseParams<V, DatabaseInsert<K>>,
  ): Promise<DatabaseRow<K> | null>;
  /** Return to the idle state; a call in flight no longer reports here. */
  reset(): void;
}

/**
 * Create rows through `POST /api/database/<entity>`. Values are typed from the
 * generated `database.d.ts`, so private, generated, and undeclared fields are
 * compile errors. Once a create succeeds, mounted database reads restart, so
 * lists and includes that show the new row refresh without a manual refetch.
 *
 * @param entity - A table the generated registry exposes
 * @param options - `invalidate` to narrow the read restart; `onSuccess` and
 *   `onError` to observe every call
 * @returns `create`, the latest call's row, loading and error state, and `reset`
 *
 * @example
 * ```tsx
 * const notes = useDatabaseCreate("notes", {
 *   onError: (error) => toast(error.message),
 * });
 *
 * async function add(body: string) {
 *   const note = await notes.create({ board_id: boardId, author: "ada", body });
 *   if (note) setDraft("");
 * }
 * ```
 */
export function useDatabaseCreate<K extends DatabaseEntity>(
  entity: K,
  options: UseDatabaseCreateOptions<K> = {},
): UseDatabaseCreateResult<K> {
  const send = useCallback(
    (values: DatabaseInsert<K>) => createDatabaseRow(entity, values as object),
    [entity],
  );
  const { onSuccess, onError } = options;
  const { mutate, ...write } = useDatabaseWrite(send, {
    invalidate: options.invalidate,
    // The server projected the row it holds; the types describe that wire.
    onSuccess:
      onSuccess &&
      ((row, [values]) => onSuccess(row as DatabaseRow<K>, values)),
    onError: onError && ((error, [values]) => onError(error, values)),
  });
  return { ...write, create: mutate } as UseDatabaseCreateResult<K>;
}
