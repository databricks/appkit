import type {
  DatabaseRegistry,
  DatabaseRegistryEntry,
  IdValue,
  OrderDirection,
} from "../../database/contract";

/** Registry shape accepted by reusable entity type helpers. */
type RegistryShape<R> = {
  readonly [K in keyof R]: DatabaseRegistryEntry;
};

export type EntityNameFor<R extends RegistryShape<R>> = Extract<
  keyof R,
  string
>;
type EntryFor<
  R extends RegistryShape<R>,
  K extends EntityNameFor<R>,
> = R[K] extends DatabaseRegistryEntry ? R[K] : never;
type RowOfFor<
  R extends RegistryShape<R>,
  K extends EntityNameFor<R>,
> = EntryFor<R, K>["row"];
type PublicRowOfFor<
  R extends RegistryShape<R>,
  K extends EntityNameFor<R>,
> = EntryFor<R, K>["publicRow"];
type InsertOfFor<
  R extends RegistryShape<R>,
  K extends EntityNameFor<R>,
> = EntryFor<R, K>["insert"];
type UpdateOfFor<
  R extends RegistryShape<R>,
  K extends EntityNameFor<R>,
> = EntryFor<R, K>["update"];
type FiltersOfFor<
  R extends RegistryShape<R>,
  K extends EntityNameFor<R>,
> = EntryFor<R, K>["filters"];
type IncludesOfFor<
  R extends RegistryShape<R>,
  K extends EntityNameFor<R>,
> = EntryFor<R, K>["includes"];

export type EntityName = EntityNameFor<DatabaseRegistry>;
type PublicRowOf<K extends EntityName> = PublicRowOfFor<DatabaseRegistry, K>;

// Resolve generated relation metadata into include arguments and result types.
type RelationTargetFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
  Relation extends keyof IncludesOfFor<Registry, K>,
> = IncludesOfFor<Registry, K>[Relation] extends {
  to: infer Target extends EntityNameFor<Registry>;
}
  ? Target
  : never;

export type IncludeOptionsFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
  Many extends boolean,
> = {
  readonly select?: readonly (keyof RowOfFor<Registry, K> & string)[];
  readonly where?: FiltersOfFor<Registry, K>;
  readonly order?: Partial<
    Record<keyof RowOfFor<Registry, K> & string, OrderDirection>
  >;
} & (Many extends true
  ? { readonly limit?: number }
  : { readonly limit?: never });

export type IncludeArgFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
> = {
  readonly [Relation in keyof IncludesOfFor<Registry, K>]?:
    | boolean
    | IncludeOptionsFor<
        Registry,
        RelationTargetFor<Registry, K, Relation>,
        IncludesOfFor<Registry, K>[Relation] extends {
          many: infer Many extends boolean;
        }
          ? Many
          : false
      >;
};

// Explicit relation projections use trusted rows; implicit projections stay public.
type IncludedRowFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
  Config,
> = Config extends {
  readonly select: infer Columns extends readonly (keyof RowOfFor<Registry, K> &
    string)[];
}
  ? Pick<RowOfFor<Registry, K>, Columns[number]>
  : PublicRowOfFor<Registry, K>;

type IncludedResultFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
  I,
> = I extends Record<string, unknown>
  ? {
      [Relation in keyof I &
        keyof IncludesOfFor<Registry, K> as I[Relation] extends false
        ? never
        : Relation]: IncludesOfFor<Registry, K>[Relation] extends {
        to: infer Target extends EntityNameFor<Registry>;
        many: infer Many;
      }
        ? Many extends true
          ? IncludedRowFor<Registry, Target, I[Relation]>[]
          : IncludedRowFor<Registry, Target, I[Relation]> | null
        : never;
    }
  : Record<never, never>;

export type EntityResultFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
  Selected,
  I,
> = Selected & IncludedResultFor<Registry, K, I>;

/** Fluent entity API shared by keyed and keyless tables. */
export interface CommonEntityClientFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
  Selected = PublicRowOfFor<Registry, K>,
  I = Record<never, never>,
> {
  where(
    filter: FiltersOfFor<Registry, K>,
  ): TypedEntityClientFor<Registry, K, Selected, I>;
  order(
    order: Partial<
      Record<keyof RowOfFor<Registry, K> & string, OrderDirection>
    >,
  ): TypedEntityClientFor<Registry, K, Selected, I>;
  select<const C extends readonly (keyof RowOfFor<Registry, K> & string)[]>(
    columns: C,
  ): TypedEntityClientFor<
    Registry,
    K,
    Pick<RowOfFor<Registry, K>, C[number]>,
    I
  >;
  include<const Next extends IncludeArgFor<Registry, K>>(
    include: Next,
  ): TypedEntityClientFor<Registry, K, Selected, Omit<I, keyof Next> & Next>;
  limit(limit: number): TypedEntityClientFor<Registry, K, Selected, I>;
  offset(offset: number): TypedEntityClientFor<Registry, K, Selected, I>;
  toArray(): Promise<Array<EntityResultFor<Registry, K, Selected, I>>>;
  first(): Promise<EntityResultFor<Registry, K, Selected, I> | null>;
  count(): Promise<number>;
  create(values: InsertOfFor<Registry, K>): Promise<RowOfFor<Registry, K>>;
  upsert(
    values: InsertOfFor<Registry, K>,
    options: { onConflict: keyof RowOfFor<Registry, K> & string },
  ): Promise<RowOfFor<Registry, K>>;
}

/** Add keyed operations only when typegen records a primary key. */
type KeyedEntityClientFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
  Selected,
  I,
> = EntryFor<Registry, K>["hasPrimaryKey"] extends true
  ? {
      find(
        id: IdValue,
      ): Promise<EntityResultFor<Registry, K, Selected, I> | null>;
      update(
        id: IdValue,
        values: UpdateOfFor<Registry, K>,
      ): Promise<RowOfFor<Registry, K> | null>;
      delete(id: IdValue): Promise<boolean>;
    }
  : Record<never, never>;

export type TypedEntityClientFor<
  Registry extends RegistryShape<Registry>,
  K extends EntityNameFor<Registry>,
  Selected = PublicRowOfFor<Registry, K>,
  I = Record<never, never>,
> = CommonEntityClientFor<Registry, K, Selected, I> &
  KeyedEntityClientFor<Registry, K, Selected, I>;

export type TypedEntityClient<
  K extends EntityName,
  Selected = PublicRowOf<K>,
  I = Record<never, never>,
> = TypedEntityClientFor<DatabaseRegistry, K, Selected, I>;

/** Parameterized SQL tag whose interpolations are always bound values. */
export type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

/** Entity and SQL capabilities bound to one transaction. */
export type TransactionClient = {
  readonly [K in EntityName]: TypedEntityClient<K>;
} & { readonly sql: SqlTag };

/** Typed database API published by the plugin. */
export type DatabaseExports = TransactionClient & {
  transaction<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T>;
};
