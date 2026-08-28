import type { Schema } from "../../database/schema-builder";
import type { EntityMutationHooks } from "./hooks";

/** Table names declared by one finalized schema. */
export type SchemaTableName<TSchema extends Schema> = Extract<
  keyof TSchema["$tables"],
  string
>;

/** Generated write operations that require an explicit HTTP opt-in. */
export type CrudWriteOperation = "create" | "update" | "delete";

/** Write exposure for every readable table or a constrained subset. */
type CrudWritesConfig<TSchema extends Schema> =
  | true
  | {
      readonly tables?: readonly SchemaTableName<TSchema>[];
      readonly operations: readonly CrudWriteOperation[];
    };

/**
 * Generated route exposure: off by default, every readable table, or an
 * explicit readable subset. Writes remain off unless `writes` names them.
 *
 * Routes run as the app's service principal and apply no per-user filter, so
 * anyone the app admits receives every enabled operation. Enabling a readable
 * table also makes it includable from its neighbours; a relation whose target
 * stays off cannot be included.
 *
 * Text filters accept caller-supplied `like`/`ilike` patterns; a server-side
 * `statement_timeout` cancels a pattern that would otherwise hold its pooled
 * connection to completion.
 */
export type CrudRoutesConfig<TSchema extends Schema> =
  | boolean
  | {
      readonly tables: readonly SchemaTableName<TSchema>[];
      readonly writes?: CrudWritesConfig<TSchema>;
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
  readonly crudRoutes?: CrudRoutesConfig<TSchema>;
  readonly hooks?: {
    readonly [TTable in SchemaTableName<TSchema>]?: EntityHooks<TTable>;
  };
};
