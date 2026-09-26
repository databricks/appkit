import { useCallback } from "react";
import type { ExactDatabaseParams } from "shared";

import { createDatabaseRow } from "@/js/database/client";
import type {
  DatabaseEntity,
  DatabaseInsert,
  DatabaseRow,
} from "@/js/database/types";

import {
  type DatabaseWriteOptions,
  type DatabaseWriteState,
  useDatabaseWrite,
} from "./use-database-write";

/** What {@link useDatabaseCreate} returns. */
export interface DatabaseCreateResult<
  K extends DatabaseEntity,
> extends DatabaseWriteState<DatabaseRow<K>> {
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
 * @param options - `invalidate` to narrow or turn off the read restart
 * @returns `create`, the latest call's row, loading and error state, and `reset`
 *
 * @example
 * ```tsx
 * const notes = useDatabaseCreate("notes");
 *
 * async function add(body: string) {
 *   const note = await notes.create({ board_id: boardId, author: "ada", body });
 *   if (note) setDraft("");
 * }
 * notes.error?.details[0]?.message;
 * ```
 */
export function useDatabaseCreate<K extends DatabaseEntity>(
  entity: K,
  options: DatabaseWriteOptions = {},
): DatabaseCreateResult<K> {
  const send = useCallback(
    (values: object) => createDatabaseRow(entity, values),
    [entity],
  );
  const { mutate, ...write } = useDatabaseWrite(
    send,
    options.invalidate ?? true,
  );
  // The server projected the row it holds; the types describe that wire.
  return { ...write, create: mutate } as DatabaseCreateResult<K>;
}
