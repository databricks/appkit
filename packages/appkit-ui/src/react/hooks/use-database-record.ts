import {
  DatabaseQueryEncodingError,
  encodeDatabaseRecordQuery,
  type ExactDatabaseParams,
} from "shared";

import { isDatabaseRow } from "@/js/database/client";
import type {
  DatabaseId,
  DatabaseKeyedEntity,
  DatabaseRecordParams,
  DatabaseRecordRow,
} from "@/js/database/types";

import {
  type DatabaseReadRequest,
  type UseDatabaseReadOptions,
  type UseDatabaseReadResult,
  useDatabaseRead,
} from "./use-database-read";

/** Options for {@link useDatabaseRecord}. */
export type UseDatabaseRecordOptions<Row> = UseDatabaseReadOptions<Row>;

/** What {@link useDatabaseRecord} returns: one row and its state. */
export type UseDatabaseRecordResult<Row> = UseDatabaseReadResult<Row>;

/**
 * Subscribe to one row from `GET /api/database/<entity>/:id`. Only entities
 * with a public primary key have this route; a missing row surfaces as a
 * `NOT_FOUND` error, and a refetch that finds the row gone clears `data`.
 *
 * A `null` or `undefined` id holds the hook idle without a request, so a
 * record that depends on another read needs no separate `enabled` flag. An
 * empty, `"."`, or `".."` id reports `INVALID_REQUEST` without a request.
 *
 * @param entity - A table the generated registry exposes with a public key
 * @param id - The row's public key, or `null`/`undefined` to wait
 * @param params - `select` and `include`; pass `{}` to reach `options` alone
 * @param options - `enabled`, `keepPreviousData`, and `shape`
 * @returns The row, loading and error state, and `refetch`
 *
 * @example
 * ```tsx
 * const board = useDatabaseRecord("boards", selectedId, {
 *   include: { notes: { limit: 20 } },
 * });
 * board.data?.notes.length;
 * ```
 */
export function useDatabaseRecord<
  K extends DatabaseKeyedEntity,
  const P extends DatabaseRecordParams<K> = Record<never, never>,
  Row = DatabaseRecordRow<K, P>,
>(
  entity: K,
  id: DatabaseId<K> | null | undefined,
  params?: P & ExactDatabaseParams<P, DatabaseRecordParams<K>>,
  options: UseDatabaseRecordOptions<Row> = {},
): UseDatabaseRecordResult<Row> {
  const enabled = (options.enabled ?? true) && id !== null && id !== undefined;
  const recordParams = (params ?? {}) as { include?: unknown };
  // Encode only an enabled read: a held read's params may still be incomplete.
  let query: DatabaseReadRequest["query"] = "";
  if (enabled) {
    try {
      query = encodeDatabaseRecordQuery(recordParams);
    } catch (error) {
      query = error instanceof DatabaseQueryEncodingError ? error : null;
    }
  }
  const read = useDatabaseRead({
    entity,
    operation: "detail",
    id: id ?? undefined,
    query,
    include: recordParams.include,
    enabled,
    accept: isDatabaseRow,
    keepPreviousData: options.keepPreviousData ?? false,
    shape: options.shape as UseDatabaseReadOptions<unknown>["shape"],
  });
  // The server projected and encoded the row; the types describe that wire.
  return read as UseDatabaseRecordResult<Row>;
}
