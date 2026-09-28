import type {
  DatabaseApiEntityFor,
  IdFor,
  InsertFor,
  KeyedEntityFor,
  ListParamsFor,
  ListRowFor,
  PublicRowFor,
  RecordParamsFor,
  RecordRowFor,
  UpdateFor,
} from "shared";

import type { DatabaseRegistry } from "./registry";

/** Entity names the generated registry binds, or `never` before typegen runs. */
export type DatabaseEntity = DatabaseApiEntityFor<DatabaseRegistry>;

/**
 * Entities with a public primary key, the only ones with a detail route.
 * A table whose key is private or absent is listable but not addressable.
 */
export type DatabaseKeyedEntity = KeyedEntityFor<DatabaseRegistry>;

/** The public primary key value that addresses one row of `K`. */
export type DatabaseId<K extends DatabaseKeyedEntity> = IdFor<
  DatabaseRegistry,
  K
>;

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

/** The public query `GET /api/database/<entity>/:id` accepts: `select` and `include`. */
export type DatabaseRecordParams<K extends DatabaseEntity> = RecordParamsFor<
  DatabaseRegistry,
  K
>;

/** One detail row as JSON carries it; projection follows the list rules. */
export type DatabaseRecordRow<
  K extends DatabaseEntity,
  P = Record<never, never>,
> = RecordRowFor<DatabaseRegistry, K, P>;

/**
 * The body `POST /api/database/<entity>` accepts: public columns the server
 * does not generate, with bigint columns as a decimal string or safe integer.
 */
export type DatabaseInsert<K extends DatabaseEntity> = InsertFor<
  DatabaseRegistry,
  K
>;

/**
 * The body `PATCH /api/database/<entity>/:id` accepts: every field optional,
 * and no key, generated, or default-stamped column.
 */
export type DatabaseUpdate<K extends DatabaseEntity> = UpdateFor<
  DatabaseRegistry,
  K
>;

/** The public row a create or update answers with, as JSON carries it. */
export type DatabaseRow<K extends DatabaseEntity> = PublicRowFor<
  DatabaseRegistry,
  K
>;
