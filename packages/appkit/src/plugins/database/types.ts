import type { Schema } from "../../database/schema-builder";

/** Table names declared by one finalized schema. */
export type SchemaTableName<TSchema extends Schema> = Extract<
  keyof TSchema["$tables"],
  string
>;

/**
 * Generated read exposure: off by default, every table, or an explicit list.
 *
 * Reads run as the app's service principal and apply no per-user filter, so an
 * enabled table is readable by anyone the app admits. Enabling a table also
 * makes it includable from its neighbours; a relation whose target stays off
 * cannot be included, which keeps one table's data behind one decision.
 *
 * Text filters accept caller-supplied `like`/`ilike` patterns, and this beta
 * adds no statement cancellation below the connector, so an expensive pattern
 * runs to completion while holding its pooled connection.
 */
export type CrudRoutesConfig<TSchema extends Schema> =
  | boolean
  | { readonly tables: readonly SchemaTableName<TSchema>[] };

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

/** Configuration for one schema-bound DatabasePlugin instance. */
export type IDatabaseConfig<TSchema extends Schema> = {
  readonly schema: TSchema;
  readonly crudRoutes?: CrudRoutesConfig<TSchema>;
  readonly hooks?: {
    readonly [TTable in SchemaTableName<TSchema>]?: {
      readonly serialize?: ReadSerializer;
    };
  };
};
