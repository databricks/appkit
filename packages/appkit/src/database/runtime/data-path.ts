import type { AppKitTable } from "../schema-builder/types";

/** Generic row shape returned by every read terminator. */
export type Row = Record<string, unknown>;

/** Sort direction accepted by `OrderSpec`. */
type Direction = "asc" | "desc";

/**
 * Operator vocabulary supported by `WhereSpec`. Names match Drizzle helpers
 * one-for-one; the runtime translates each into the matching helper (`eq`,
 * `ne`, `gt`, …) when the query is built.
 */
type WhereOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "in"
  | "is";

/**
 * Per-column predicate. Bare value is shorthand for equality; an array is
 * shorthand for `IN`; an object selects one or more operators.
 */
type WhereValue =
  | string
  | number
  | boolean
  | null
  | readonly (string | number | boolean | null)[]
  | { [K in WhereOperator]?: unknown };

/** Filter map: column name → predicate. */
export type WhereSpec = Record<string, WhereValue>;

/** Order map: column name → direction (default: `asc`). */
export type OrderSpec = Record<string, Direction>;

/**
 * Per-relation include options. `select` projects related columns; `where`
 * narrows them; `limit` and `order` paginate them. Nested includes are
 * intentionally out of MVP scope.
 */
export interface IncludeOptions {
  /** Restrict the related row's columns. Defaults to all columns. */
  select?: ReadonlyArray<string>;
  /** Cap the related rows fetched per parent. */
  limit?: number;
  /** Order the related rows. */
  order?: OrderSpec;
  /** Filter the related rows. */
  where?: WhereSpec;
}

/**
 * Eager-load shape: relation name → either `true` (all default) or an options
 * bag. The runtime resolves relation names against the parent table's
 * `$relations` metadata; unknown names throw at query time.
 */
export type IncludeSpec = Record<string, true | IncludeOptions>;

/** Options accepted by `DataPath.select`. */
export interface SelectOptions {
  where?: WhereSpec;
  order?: OrderSpec;
  limit?: number;
  offset?: number;
  /** Project specific columns. Defaults to `*`. */
  columns?: ReadonlyArray<string>;
  /** Eager-load related entities. */
  include?: IncludeSpec;
  /**
   * Reserved. `node-postgres` does not honor `AbortSignal` at the query level
   * today — runaway queries are bounded server-side by Postgres
   * `statement_timeout` (set by the plugin on every pool connection). The
   * AppKit timeout interceptor still rejects the JS promise when fired.
   */
  signal?: AbortSignal;
}

/** Options accepted by `DataPath.findOne`. */
export interface FindOneOptions {
  columns?: ReadonlyArray<string>;
  include?: IncludeSpec;
  signal?: AbortSignal;
}

/** Options accepted by `DataPath.count`. */
export interface CountOptions {
  where?: WhereSpec;
  signal?: AbortSignal;
}

/**
 * AppKit-shaped abstraction over the runtime data path.
 *
 * The entity proxy and route layer talk to this interface only. The
 * implementation in `drizzle-runtime.ts` is the *only* AppKit file that
 * imports `drizzle-orm` for query execution. Swapping Drizzle for Kysely,
 * Knex, or raw SQL means rewriting one file.
 *
 * Identity, OBO, telemetry, hook dispatch, and validation all live above this
 * interface — `DataPath` is plain "execute these reads/writes against this
 * pool". Pool selection (SP vs per-user) happens in `entity-wiring.ts`.
 */
export interface DataPath {
  /** Run a SELECT and return rows (with optional eager joins). */
  select(table: AppKitTable, opts: SelectOptions): Promise<Row[]>;

  /** Find one row by primary key, or `null` when no row matches. */
  findOne(
    table: AppKitTable,
    pkColumn: string,
    id: string | number,
    opts?: FindOneOptions,
  ): Promise<Row | null>;

  /** Count rows matching `where`. */
  count(table: AppKitTable, opts: CountOptions): Promise<number>;

  /** INSERT one row and return the inserted row (with server-generated columns). */
  insert(table: AppKitTable, data: Row, signal?: AbortSignal): Promise<Row>;

  /**
   * UPDATE one row by primary key. Returns the updated row, or `null` when
   * no row matches. Hook dispatch and Zod validation happen above this layer.
   */
  update(
    table: AppKitTable,
    pkColumn: string,
    id: string | number,
    patch: Row,
    signal?: AbortSignal,
  ): Promise<Row | null>;

  /**
   * INSERT … ON CONFLICT (`onConflict`) DO UPDATE. Returns the resulting row.
   * `onConflict` is a column name in the table (single-column unique constraint).
   */
  upsert(
    table: AppKitTable,
    data: Row,
    options: { onConflict: string },
    signal?: AbortSignal,
  ): Promise<Row>;

  /** DELETE one row by primary key. No-op when no row matches. */
  delete(
    table: AppKitTable,
    pkColumn: string,
    id: string | number,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Run `fn` inside a database transaction. The nested `DataPath` shares the
   * same surface; rollbacks happen on throw, commits on resolution.
   */
  transaction<T>(fn: (tx: DataPath) => Promise<T>): Promise<T>;

  /**
   * Tagged-template SQL escape hatch. Values are bound as parameters; column
   * and identifier interpolation is intentionally not supported here — drop
   * to `appkit.database.getPool().query(...)` if you need that.
   */
  raw<T = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
}
