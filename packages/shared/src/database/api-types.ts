/**
 * Generic HTTP types over any generated database registry. The registry itself
 * is one generated `database.d.ts`; these adapters only read the facets each
 * entry already carries, so there is no second model of an entity here.
 */

/** The HTTP-safe facets every generated registry entry carries. */
export interface DatabaseApiEntry {
  /** Non-private columns, as the trusted runtime types them. */
  readonly publicRow: Record<string, unknown>;
  /** Relation target table and cardinality, one entry per relation. */
  readonly includes: Record<string, unknown>;
  /** What the generated routes accept, computed by the server's own predicates. */
  readonly api: {
    readonly insert: object;
    readonly update: object;
    readonly filters: object;
    /** Columns a request may order by; `never` when there are none. */
    readonly orderable: string;
    /** The public primary key; `never` when it is private or absent. */
    readonly key: string;
  };
}

type Primitive = string | number | bigint | boolean | symbol | null | undefined;

/** JSON carries a bigint as a decimal string, at every depth of a response. */
export type WireOutput<T> = T extends bigint
  ? string
  : T extends readonly (infer E)[]
    ? WireOutput<E>[]
    : T extends object
      ? { [K in keyof T]: WireOutput<T[K]> }
      : T;

/** A bigint input travels as a decimal string or a safe integer. */
export type WireInput<T> = T extends bigint
  ? string | number
  : T extends readonly (infer E)[]
    ? readonly WireInput<E>[]
    : T extends object
      ? { [K in keyof T]: WireInput<T[K]> }
      : T;

/** Literal entity names in `R`, or `never` while the registry is empty. */
export type DatabaseApiEntityFor<R> = Extract<
  keyof { [K in keyof R as string extends K ? never : K]: true },
  string
>;

type EntryOf<R, K> = K extends keyof R
  ? R[K] extends DatabaseApiEntry
    ? R[K]
    : never
  : never;
type PublicRowOf<R, K> = EntryOf<R, K>["publicRow"];
type ApiOf<R, K> = EntryOf<R, K>["api"];
type IncludesOf<R, K> = EntryOf<R, K>["includes"];
type RelationOf<R, K, Relation> = IncludesOf<R, K>[Relation &
  keyof IncludesOf<R, K>];
type TargetOf<R, K, Relation> =
  RelationOf<R, K, Relation> extends { to: infer Target } ? Target : never;
type ToManyOf<R, K, Relation> =
  RelationOf<R, K, Relation> extends { many: true } ? true : false;

type SelectableOf<R, K> = keyof PublicRowOf<R, K> & string;
type OrderFor<R, K> = Partial<Record<ApiOf<R, K>["orderable"], "asc" | "desc">>;

/**
 * Options for one included relation, checked against the target's own public
 * facets. Only a to-many edge takes a limit, and only the first edge nests.
 */
type IncludeOptionsFor<R, Target, ToMany, Nested> = {
  readonly select?: readonly SelectableOf<R, Target>[];
  readonly where?: WireInput<ApiOf<R, Target>["filters"]>;
  readonly order?: OrderFor<R, Target>;
} & (ToMany extends true
  ? { readonly limit?: number }
  : { readonly limit?: never }) &
  (Nested extends true
    ? { readonly include?: HttpIncludeArgFor<R, Target, false> }
    : { readonly include?: never });

/**
 * `include` as the generated routes decode it: `true` or an options object per
 * relation (never `false`), at most two relation edges deep.
 */
export type HttpIncludeArgFor<R, K, Nested extends boolean = true> = {
  readonly [Relation in keyof IncludesOf<R, K>]?:
    | true
    | IncludeOptionsFor<
        R,
        TargetOf<R, K, Relation>,
        ToManyOf<R, K, Relation>,
        Nested
      >;
};

/** The public query a generated list route accepts for `K`. */
export type ListParamsFor<R, K> = {
  readonly where?: WireInput<ApiOf<R, K>["filters"]>;
  readonly order?: OrderFor<R, K>;
  readonly select?: readonly SelectableOf<R, K>[];
  readonly include?: HttpIncludeArgFor<R, K>;
  readonly limit?: number;
  readonly offset?: number;
};

/** The public query a generated detail route accepts for `K`. */
export type RecordParamsFor<R, K> = Pick<
  ListParamsFor<R, K>,
  "select" | "include"
>;

// An explicit selection narrows the public row; relations add to it.
type SelectedOf<R, K, P> = P extends {
  readonly select: infer Columns extends readonly PropertyKey[];
}
  ? Pick<PublicRowOf<R, K>, Columns[number] & keyof PublicRowOf<R, K>>
  : PublicRowOf<R, K>;

type IncludedOf<R, K, P> = P extends { readonly include: infer I }
  ? {
      [Relation in keyof I & keyof IncludesOf<R, K>]: ToManyOf<
        R,
        K,
        Relation
      > extends true
        ? RowOf<R, TargetOf<R, K, Relation>, I[Relation]>[]
        : RowOf<R, TargetOf<R, K, Relation>, I[Relation]> | null;
    }
  : unknown;

type RowOf<R, K, P> = SelectedOf<R, K, P> & IncludedOf<R, K, P>;

/** One list row as JSON carries it, for the params `P` the caller sent. */
export type ListRowFor<R, K, P> = WireOutput<RowOf<R, K, P>>;

/** One detail row as JSON carries it; projection follows the list rules. */
export type RecordRowFor<R, K, P> = ListRowFor<R, K, P>;

/** The envelope a generated list route answers with. */
export interface DatabaseListPage<Row> {
  items: Row[];
  limit: number;
  offset: number;
}

type KeysOf<S> = S extends unknown ? keyof S : never;
type PropertyOf<S, K extends PropertyKey> = S extends unknown
  ? K extends keyof S
    ? S[K]
    : never
  : never;
type ObjectPartOf<S> = Exclude<S, Primitive | readonly unknown[]>;
type ElementOf<S> = S extends readonly (infer E)[] ? E : never;

/**
 * Turn every key `Shape` does not declare into `never`, at every depth.
 * TypeScript skips excess-property checks for an inferred generic argument,
 * so `P & ExactDatabaseParams<P, Shape>` restores them: a private or unknown
 * column beside a valid one is a compile error, not a silent 400.
 */
export type ExactDatabaseParams<T, Shape> = [Shape] extends [T]
  ? T
  : T extends Primitive
    ? T
    : T extends readonly unknown[]
      ? { readonly [I in keyof T]: ExactDatabaseParams<T[I], ElementOf<Shape>> }
      : {
          [K in keyof T]: K extends KeysOf<ObjectPartOf<Shape>>
            ? ExactDatabaseParams<
                T[K],
                NonNullable<PropertyOf<ObjectPartOf<Shape>, K>>
              >
            : never;
        };
