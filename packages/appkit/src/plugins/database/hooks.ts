// biome-ignore-all lint/suspicious/noConfusingVoidType: a before hook either returns a replacement payload or nothing.

import type {
  DatabaseRegistry,
  DatabaseRegistryEntry,
  IdValue,
} from "../../database/contract";
import type { Row } from "../../database/runtime";
import type { TransactionClient } from "./entity-types";

/** The only capability a hook receives: entities bound to its transaction. */
export interface HookApp {
  readonly database: TransactionClient;
}

/** Which entity is being mutated, and the surface a hook may write through. */
export interface HookContext {
  readonly entity: string;
  readonly app: HookApp;
}

// Payload facets stay untyped rows until typegen augments the registry.
type FacetOf<
  TTable,
  TFacet extends "row" | "insert" | "update",
> = TTable extends keyof DatabaseRegistry
  ? DatabaseRegistry[TTable] extends DatabaseRegistryEntry
    ? DatabaseRegistry[TTable][TFacet]
    : Row
  : Row;

type MaybePromise<T> = T | Promise<T>;

/**
 * Mutation lifecycle for one entity. A before hook may return a replacement
 * payload, which is revalidated against the trusted schema before it is
 * persisted. Every hook, the mutation, and any write a hook issues through
 * `ctx.app.database` share one transaction, so a rejection anywhere rolls all
 * of them back. Throw `DatabaseValidationError` to answer a generated route
 * with `422`; any other failure stays an opaque server error.
 */
export interface EntityMutationHooks<TTable extends string = string> {
  beforeCreate?(
    values: FacetOf<TTable, "insert">,
    context: HookContext,
  ): MaybePromise<FacetOf<TTable, "insert"> | void>;
  afterCreate?(
    row: FacetOf<TTable, "row">,
    context: HookContext,
  ): MaybePromise<void>;
  beforeUpdate?(
    id: IdValue,
    values: FacetOf<TTable, "update">,
    context: HookContext,
  ): MaybePromise<FacetOf<TTable, "update"> | void>;
  afterUpdate?(
    row: FacetOf<TTable, "row">,
    context: HookContext,
  ): MaybePromise<void>;
  beforeUpsert?(
    values: FacetOf<TTable, "insert">,
    context: HookContext,
  ): MaybePromise<FacetOf<TTable, "insert"> | void>;
  afterUpsert?(
    row: FacetOf<TTable, "row">,
    context: HookContext,
  ): MaybePromise<void>;
  beforeDelete?(id: IdValue, context: HookContext): MaybePromise<void>;
  afterDelete?(id: IdValue, context: HookContext): MaybePromise<void>;
}

/** Which mutation a hook frame belongs to. */
export type MutationOperation = "create" | "update" | "upsert" | "delete";
