/**
 * Database registry — augmented by the AppKit type generator from `schema.ts`.
 *
 * Emits `declare module "@databricks/appkit-ui/js" { interface DatabaseRegistry { … } }`.
 * Shared by the browser `db` client and server `appkit.database` imports.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — populated via module augmentation
export interface DatabaseRegistry {}

/** Literal keys from augmentation only (drops index signatures). */
type AugmentedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : K]: T[K];
};

/** Augmented entity names, or `string` before the generator runs. */
export type DatabaseEntityKey = AugmentedKeys<DatabaseRegistry> extends never
  ? string
  : AugmentedKeys<DatabaseRegistry>;

/** Row shape for entity `E`. Unknown before module augmentation. */
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
 * `.where(...)` predicate: bare values are `eq`; objects pick operators per column.
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

/** Related row shape: single `{ row }` or `{ row }[]` from the registry. */
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

/** Maps included relation keys onto extra fields (object vs array per cardinality). */
export type ApplyIncludes<TIncludes, I> = {
  [K in keyof I & keyof TIncludes]: TIncludes[K] extends Array<infer _>
    ? RelatedRow<TIncludes, K>[]
    : RelatedRow<TIncludes, K>;
};

/**
 * Browser `EntityClient` — mirrors server `EntityClient`; chain methods build
 * one HTTP request to `/api/database/<entity>`.
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

  /** Eager-load relations → `?include=` (PostgREST-style). */
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
  /**
   * PATCH by id — `null` on 404 (like `find()`); otherwise rejects with `DatabaseHTTPError`.
   */
  update(
    id: string | number,
    patch: TUpdate,
    signal?: AbortSignal,
  ): Promise<TRow | null>;
  upsert(
    data: TInsert,
    options: { onConflict: keyof TRow & string },
    signal?: AbortSignal,
  ): Promise<TRow>;
  delete(id: string | number, signal?: AbortSignal): Promise<void>;
}

/**
 * Return type of `createDatabaseClient()`. Entity keys become typed clients once
 * `DatabaseRegistry` is augmented; before that, entities are loose `unknown` rows.
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
