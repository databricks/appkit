import { encodeDatabaseRecordQuery, type ExactDatabaseParams } from "shared";

import { isDatabaseRow } from "@/js/database/client";
import type {
  DatabaseId,
  DatabaseKeyedEntity,
  DatabaseRecordParams,
  DatabaseRecordRow,
} from "@/js/database/types";

import {
  type DatabaseReadOptions,
  type DatabaseReadResult,
  useDatabaseRead,
} from "./use-database-read";

/**
 * Subscribe to one row from `GET /api/database/<entity>/:id`. Only entities
 * with a public primary key have this route; a missing row surfaces as a
 * `NOT_FOUND` error.
 *
 * A `null` or `undefined` id holds the hook idle without a request, so a
 * record that depends on another read needs no separate `enabled` flag.
 *
 * @param entity - A table the generated registry exposes with a public key
 * @param id - The row's public key, or `null`/`undefined` to wait
 * @param params - `select` and `include`
 * @param options - `enabled` to hold the request; `shape` for a serializer's row
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
  options: DatabaseReadOptions<Row> = {},
): DatabaseReadResult<Row> {
  const read = useDatabaseRead(
    entity,
    "detail",
    id ?? undefined,
    encodeDatabaseRecordQuery(params ?? {}),
    (options.enabled ?? true) && id !== null && id !== undefined,
    isDatabaseRow,
  );
  // The server projected and encoded the row; the types describe that wire.
  return read as DatabaseReadResult<Row>;
}
