/**
 * Database registry — augmented by the `appkit` type generator (C10).
 *
 * Starts empty. The type generator emits a `.d.ts` with
 * `declare module "@databricks/appkit-ui/js" { interface DatabaseRegistry { ... } }`
 * so that `db.<entity>` is typed end-to-end once a `config/database/schema.ts`
 * exists in the consuming app.
 *
 * Consumed by both the browser `db` (this file) and the server
 * `appkit.database` via `import type { DatabaseRegistry } from "@databricks/appkit-ui/js"`.
 * Single declaration, single source of truth.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — populated via module augmentation
export interface DatabaseRegistry {}

/** Extracts only the literal keys added via module augmentation, skipping any index signature. */
type AugmentedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : K]: T[K];
};

/**
 * Resolves to the union of augmented entity names, or `string` as a loose
 * fallback when the registry hasn't been populated by the type generator yet.
 */
export type DatabaseEntityKey = AugmentedKeys<DatabaseRegistry> extends never
  ? string
  : AugmentedKeys<DatabaseRegistry>;

/** Row shape for entity `E`. Falls back to `unknown` before C10 augments. */
export type DatabaseRow<E extends DatabaseEntityKey> =
  DatabaseRegistry extends {
    [K in E]: { row: infer R };
  }
    ? R
    : unknown;

/** Insert shape for entity `E`. Falls back to `Record<string, unknown>`. */
export type DatabaseInsert<E extends DatabaseEntityKey> =
  DatabaseRegistry extends { [K in E]: { insert: infer I } }
    ? I
    : Record<string, unknown>;

/** Update shape for entity `E`. Falls back to `Record<string, unknown>`. */
export type DatabaseUpdate<E extends DatabaseEntityKey> =
  DatabaseRegistry extends { [K in E]: { update: infer U } }
    ? U
    : Record<string, unknown>;

/** Includes map for entity `E`. Empty object when no relations exist. */
export type DatabaseIncludes<E extends DatabaseEntityKey> =
  DatabaseRegistry extends { [K in E]: { includes: infer I } }
    ? I
    : Record<string, never>;

/**
 * Operator-style predicate accepted by `.where(...)`. Any bare value is shorthand
 * for equality. An object picks one or more operators for the column.
 */
export type WhereInput<TRow> = {
  [K in keyof TRow]?:
    | TRow[K]
    | {
        eq?: TRow[K];
        neq?: TRow[K];
        gt?: TRow[K];
        gte?: TRow[K];
        lt?: TRow[K];
        lte?: TRow[K];
        like?: string;
        ilike?: string;
        in?: TRow[K][];
        is?: TRow[K] | null;
      };
};

/** Sort directive for `.order(...)`. */
export type OrderInput<TRow> = { [K in keyof TRow]?: "asc" | "desc" };

/**
 * The underlying row for a related entity. Handles both many-to-one
 * (single `{ row: R }`) and one-to-many (`{ row: R }[]`) registry shapes.
 */
export type RelatedRow<
  TIncludes,
  K extends keyof TIncludes,
> = TIncludes[K] extends { row: infer R }
  ? R
  : TIncludes[K] extends Array<{ row: infer R }>
    ? R
    : Record<string, unknown>;

/** Per-relation include spec — `true` for default fetch, object for refined select. */
export type IncludeInput<TIncludes> = {
  [K in keyof TIncludes]?:
    | true
    | {
        select?: ReadonlyArray<keyof RelatedRow<TIncludes, K>>;
      };
};

/**
 * Maps the `I` include input to additional fields on the returned row. Arrays
 * for one-to-many relations, plain objects for many-to-one.
 */
export type ApplyIncludes<TIncludes, I> = {
  [K in keyof I & keyof TIncludes]: TIncludes[K] extends Array<infer _>
    ? RelatedRow<TIncludes, K>[]
    : RelatedRow<TIncludes, K>;
};

/**
 * Browser `EntityClient` — structurally symmetric with the server-side
 * `EntityClient` from `@databricks/appkit`. Each terminator performs a single
 * HTTP request against `/api/database/<entity>`; the chain methods mutate an
 * internal request descriptor.
 */
export interface EntityClient<
  TRow,
  TInsert,
  TUpdate,
  TIncludes = Record<string, never>,
> {
  where(
    input: WhereInput<TRow>,
  ): EntityClient<TRow, TInsert, TUpdate, TIncludes>;
  order(
    input: OrderInput<TRow>,
  ): EntityClient<TRow, TInsert, TUpdate, TIncludes>;
  limit(n: number): EntityClient<TRow, TInsert, TUpdate, TIncludes>;
  offset(n: number): EntityClient<TRow, TInsert, TUpdate, TIncludes>;
  select<K extends keyof TRow>(
    ...cols: K[]
  ): EntityClient<Pick<TRow, K>, TInsert, TUpdate, TIncludes>;

  /**
   * Eager-load related entities. Serializes `{ posts: true }` into AppKit's
   * route-owned `?include=posts` query syntax.
   */
  include<I extends IncludeInput<TIncludes>>(
    input: I,
  ): EntityClient<
    TRow & ApplyIncludes<TIncludes, I>,
    TInsert,
    TUpdate,
    TIncludes
  >;

  toArray(signal?: AbortSignal): Promise<TRow[]>;
  first(signal?: AbortSignal): Promise<TRow | null>;
  find(id: string | number, signal?: AbortSignal): Promise<TRow | null>;
  count(signal?: AbortSignal): Promise<number>;

  create(data: TInsert, signal?: AbortSignal): Promise<TRow>;
  update(
    id: string | number,
    patch: TUpdate,
    signal?: AbortSignal,
  ): Promise<TRow>;
  upsert(
    data: TInsert,
    options: { onConflict: keyof TRow & string },
    signal?: AbortSignal,
  ): Promise<TRow>;
  delete(id: string | number, signal?: AbortSignal): Promise<void>;
}

/**
 * The shape returned by `createDatabaseClient()`. Entity names resolve to typed
 * `EntityClient`s once `DatabaseRegistry` is augmented by the type generator.
 * Before augmentation, each entity is `EntityClient<unknown, ...>` — still
 * functional at runtime but loosely typed.
 */
export type DatabaseClient = {
  [E in DatabaseEntityKey]: EntityClient<
    DatabaseRow<E>,
    DatabaseInsert<E>,
    DatabaseUpdate<E>,
    DatabaseIncludes<E>
  >;
};

export interface DatabaseClientConfig {
  /** Base URL for AppKit database routes. Defaults to `/api/database`. */
  baseUrl?: string;
  /** Fetch implementation override — useful for tests or custom credentials. */
  fetch?: typeof fetch;
}
