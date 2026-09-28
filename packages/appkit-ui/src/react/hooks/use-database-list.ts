import {
  type DatabaseListPage,
  type DatabaseListQuery,
  encodeDatabaseListQuery,
  type ExactDatabaseParams,
} from "shared";

import { isDatabaseListPage } from "@/js/database/client";
import type {
  DatabaseEntity,
  DatabaseKeyedEntity,
  DatabaseListParams,
  DatabaseListRow,
} from "@/js/database/types";

import {
  type UseDatabaseReadOptions,
  type UseDatabaseReadResult,
  useDatabaseRead,
} from "./use-database-read";

/** Options for {@link useDatabaseList}. */
export type UseDatabaseListOptions<Row> = UseDatabaseReadOptions<Row>;

/** What {@link useDatabaseList} returns: one page of rows and its state. */
export type UseDatabaseListResult<Row> = UseDatabaseReadResult<
  DatabaseListPage<Row>
>;

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
 * @param params - `where`, `order`, `select`, `include`, `limit`, `offset`;
 *   `null` holds the hook idle, for params that depend on another read
 * @param options - `enabled`, `keepPreviousData`, and `shape`
 * @returns The page, loading and error state, and `refetch`
 *
 * @example
 * ```tsx
 * const notes = useDatabaseList(
 *   "notes",
 *   board ? { where: { board_id: board.id }, limit: 20, offset } : null,
 *   { keepPreviousData: true },
 * );
 * notes.data?.items.map((note) => note.body);
 * ```
 */
export function useDatabaseList<
  K extends DatabaseKeyedEntity,
  Row = DatabaseListRow<K>,
>(
  entity: K,
  params?: undefined,
  options?: UseDatabaseListOptions<Row>,
): UseDatabaseListResult<Row>;
export function useDatabaseList<
  K extends DatabaseEntity,
  const P extends DatabaseListParams<K>,
  Row = DatabaseListRow<K, P>,
>(
  entity: K,
  params: (P & ExactDatabaseParams<P, DatabaseListParams<K>>) | null,
  options?: UseDatabaseListOptions<Row>,
): UseDatabaseListResult<Row>;
export function useDatabaseList(
  entity: string,
  params?: DatabaseListQuery | null,
  options: UseDatabaseListOptions<unknown> = {},
): UseDatabaseListResult<unknown> {
  const enabled = (options.enabled ?? true) && params !== null;
  // Encode only an enabled read: a held read's params may still be incomplete.
  let query: string | null = "";
  if (enabled) {
    try {
      query = encodeDatabaseListQuery(params ?? {});
    } catch {
      query = null;
    }
  }
  const read = useDatabaseRead({
    entity,
    operation: "list",
    id: undefined,
    query,
    include: params?.include,
    enabled,
    accept: isDatabaseListPage,
    keepPreviousData: options.keepPreviousData ?? false,
    shape: options.shape,
  });
  return read as UseDatabaseListResult<unknown>;
}
