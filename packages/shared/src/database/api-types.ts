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
  /** What default operation contracts accept, from the server's own predicates. */
  readonly api: {
    readonly insert: object;
    readonly update: object;
    /** The public primary key a default contract's `id` carries; `never` for all other keys. */
    readonly key: string;
  };
}

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
