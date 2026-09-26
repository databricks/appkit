import type { DatabaseApiEntityFor, ListParamsFor, ListRowFor } from "shared";

import type { DatabaseRegistry } from "./registry";

/** Entity names the generated registry binds, or `never` before typegen runs. */
export type DatabaseEntity = DatabaseApiEntityFor<DatabaseRegistry>;

/**
 * The public query `GET /api/database/<entity>` accepts: filters and ordering
 * over queryable columns, projection over public columns, and includes over
 * relations, each checked against the target's own public facets.
 */
export type DatabaseListParams<K extends DatabaseEntity> = ListParamsFor<
  DatabaseRegistry,
  K
>;

/**
 * One list row as JSON carries it: the public row, narrowed by `select` and
 * widened by `include`, with bigint columns as decimal strings.
 */
export type DatabaseListRow<
  K extends DatabaseEntity,
  P = Record<never, never>,
> = ListRowFor<DatabaseRegistry, K, P>;
