import type { Schema } from "../../database/schema-builder";
import type { EntityMutationHooks } from "./hooks";

/** Table names declared by one finalized schema. */
export type SchemaTableName<TSchema extends Schema> = Extract<
  keyof TSchema["$tables"],
  string
>;

/** Generated HTTP write operations. */
export type DatabaseApiWriteOperation = "create" | "update" | "delete";

/** All writes by default; false keeps reads only, and an object narrows writes. */
export type DatabaseApiWritesConfig<TSchema extends Schema> =
  | boolean
  | {
      /** Tables that remain writable. Defaults to every exposed table. */
      readonly tables?: readonly SchemaTableName<TSchema>[];
      /** Operations that remain enabled. Defaults to create, update, and delete. */
      readonly operations?: readonly DatabaseApiWriteOperation[];
    };

/**
 * Full generated CRUD for every declared table by default. Set false to disable
 * all generated routes, or use an object to restrict tables and writes.
 * Keyed routes require a public primary key; upsert stays programmatic.
 * Route names must start with a letter, contain only letters, digits, `_`, or
 * `-`, be at most 64 characters, and be unique ignoring case. Invalid names
 * fail setup; exclude internal tables with `api.tables` or use `api: false`.
 *
 * Routes run as the app's service principal and apply no per-user filter, so
 * anyone the app admits receives every enabled operation. An exposed table
 * also becomes includable from its neighbours; a relation whose target
 * stays off cannot be included.
 *
 * Text filters accept caller-supplied `like`/`ilike` patterns; a server-side
 * `statement_timeout` cancels a pattern that would otherwise hold its pooled
 * connection to completion.
 */
export type DatabaseApiConfig<TSchema extends Schema> =
  | boolean
  | {
      /** Tables that remain exposed. Defaults to every declared table. */
      readonly tables?: readonly SchemaTableName<TSchema>[];
      /** All writes by default. Set false for read-only routes. */
      readonly writes?: DatabaseApiWritesConfig<TSchema>;
    };

/** Which entity and generated operation produced the row being shaped. */
export interface ReadSerializerContext {
  readonly entity: string;
  readonly operation: "list" | "detail";
}

/**
 * Shape one already private-safe row before it reaches the wire. A `Promise`
 * is not assignable to the return type, so an async callback fails to compile:
 * serializers run inside the response path and must not add latency there.
 */
export type ReadSerializer = (
  row: Record<string, unknown>,
  context: ReadSerializerContext,
) => Record<string, unknown>;

/** Response shaping and mutation lifecycle declared for one table. */
export type EntityHooks<TTable extends string = string> =
  EntityMutationHooks<TTable> & {
    readonly serialize?: ReadSerializer;
  };

/** Hooks addressed by runtime table name, once the typed keys are erased. */
export type DatabaseHooks = Readonly<Record<string, EntityHooks | undefined>>;

/** Configuration for one schema-bound DatabasePlugin instance. */
export type IDatabaseConfig<TSchema extends Schema> = {
  readonly schema: TSchema;
  /**
   * Generated HTTP CRUD is enabled for all tables by default, using the app's
   * service principal. Every admitted caller receives the enabled operations;
   * no per-user or per-row authorization is applied. This plugin does not
   * support OBO. Use custom routes for application-specific authorization.
   *
   * Set `false` to disable routes, `{ writes: false }` for reads only, or
   * `{ tables: ["notes"] }` to expose only selected tables. To disable delete,
   * use `{ writes: { operations: ["create", "update"] } }`.
   *
   * @defaultValue true
   */
  readonly api?: DatabaseApiConfig<TSchema>;
  readonly hooks?: {
    readonly [TTable in SchemaTableName<TSchema>]?: EntityHooks<TTable>;
  };
};
