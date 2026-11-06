import {
  type DatabaseListPage,
  type DatabaseListQuery,
  DatabaseQueryEncodingError,
  encodeDatabaseListQuery,
  type ExactDatabaseParams,
} from "shared";

import { isDatabaseListPage } from "@/js/database/entity-client";
import type {
  DatabaseEntity,
  DatabaseKeyedEntity,
  DatabaseListParams,
  DatabaseListRow,
} from "@/js/database/types";

import {
  type DatabaseReadRequest,
  type UseDatabaseReadOptions,
  type UseDatabaseReadResult,
  useDatabaseRead,
} from "./use-database-read";

/** Options for {@link useDatabaseList}. */
export type UseDatabaseListOptions = UseDatabaseReadOptions;

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
 * @param options - `enabled` and `keepPreviousData`
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
export function useDatabaseList<K extends DatabaseKeyedEntity>(
  entity: K,
  params?: undefined,
  options?: UseDatabaseListOptions,
): UseDatabaseListResult<DatabaseListRow<K>>;
export function useDatabaseList<
  K extends DatabaseEntity,
  const P extends DatabaseListParams<K>,
>(
  entity: K,
  params: (P & ExactDatabaseParams<P, DatabaseListParams<K>>) | null,
  options?: UseDatabaseListOptions,
): UseDatabaseListResult<DatabaseListRow<K, P>>;
export function useDatabaseList(
  entity: string,
  params?: DatabaseListQuery | null,
  options: UseDatabaseListOptions = {},
): UseDatabaseListResult<unknown> {
  const enabled = (options.enabled ?? true) && params !== null;
  // Encode only an enabled read: a held read's params may still be incomplete.
  let query: DatabaseReadRequest["query"] = "";
  if (enabled) {
    try {
      query = encodeDatabaseListQuery(params ?? {});
    } catch (error) {
      query = error instanceof DatabaseQueryEncodingError ? error : null;
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
  });
  return read as UseDatabaseListResult<unknown>;
}
