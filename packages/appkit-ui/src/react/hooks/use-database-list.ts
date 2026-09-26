import {
  type DatabaseListPage,
  encodeDatabaseListQuery,
  type ExactDatabaseParams,
} from "shared";

import { isDatabaseListPage } from "@/js/database/client";
import type {
  DatabaseEntity,
  DatabaseListParams,
  DatabaseListRow,
} from "@/js/database/types";

import {
  type DatabaseReadOptions,
  type DatabaseReadResult,
  useDatabaseRead,
} from "./use-database-read";

/**
 * Subscribe to one page of `GET /api/database/<entity>`. Entity, params, and
 * rows are typed from the generated `database.d.ts`; the route comes from the
 * endpoints the server published.
 *
 * Mounted hooks whose params encode to the same query share one request, so
 * an inline params literal does not refetch on every render. The request is
 * aborted once its last subscriber unmounts.
 *
 * @param entity - A table the generated registry exposes
 * @param params - `where`, `order`, `select`, `include`, `limit`, `offset`
 * @param options - `enabled` to hold the request; `shape` for a serializer's row
 * @returns The page, loading and error state, and `refetch`
 *
 * @example
 * ```tsx
 * const notes = useDatabaseList(
 *   "notes",
 *   { where: { board_id: boardId }, order: { created_at: "desc" }, limit: 5 },
 *   { enabled: boardId !== undefined },
 * );
 * notes.data?.items.map((note) => note.body);
 * ```
 */
export function useDatabaseList<
  K extends DatabaseEntity,
  const P extends DatabaseListParams<K> = Record<never, never>,
  Row = DatabaseListRow<K, P>,
>(
  entity: K,
  params?: P & ExactDatabaseParams<P, DatabaseListParams<K>>,
  options: DatabaseReadOptions<Row> = {},
): DatabaseReadResult<DatabaseListPage<Row>> {
  const read = useDatabaseRead(
    entity,
    "list",
    undefined,
    encodeDatabaseListQuery(params ?? {}),
    options.enabled ?? true,
    isDatabaseListPage,
  );
  // The server projected and encoded every row; the types describe that wire.
  return read as DatabaseReadResult<DatabaseListPage<Row>>;
}
