import {
  DEFAULT_LIMIT,
  type FilterOperator,
  MAX_LIMIT,
  MAX_OFFSET,
} from "../contract";
import type { AppKitTable, ColumnMeta } from "../schema-builder";

export type IdValue = string | number | bigint;
export type ScalarValue = string | number | bigint | boolean | null;
/** Operators for one column; array operands are reserved for `in`. */
export type FilterOps = Partial<
  Record<FilterOperator, ScalarValue | readonly ScalarValue[]>
>;
export type WhereValue = ScalarValue | readonly ScalarValue[] | FilterOps;
/** Direct-column predicates with explicit `and` and `or` predicate groups. */
export type WhereClause = Readonly<
  Record<string, WhereValue | readonly WhereClause[]>
>;

export type OrderDirection = "asc" | "desc";
export type OrderSpec = Readonly<Record<string, OrderDirection>>;

export interface IncludeOptions {
  readonly select?: readonly string[];
  readonly where?: WhereClause;
  readonly order?: OrderSpec;
  readonly limit?: number;
}

/** Selection and bounds for one declared relation edge. */
export type IncludeSpec = Readonly<Record<string, boolean | IncludeOptions>>;

/** A bounded root read; adapters apply defaults and validate explicit bounds. */
export interface QuerySpec {
  readonly where?: WhereClause;
  readonly order?: OrderSpec;
  readonly select?: readonly string[];
  readonly include?: IncludeSpec;
  readonly limit?: number;
  readonly offset?: number;
}

export type Row = Record<string, unknown>;

/**
 * Backend-neutral operations; field names are schema keys that an adapter must
 * resolve, never caller-provided SQL identifiers.
 */
export interface DataPath {
  /** Read a bounded collection from one finalized table. */
  select(table: AppKitTable, spec: QuerySpec): Promise<Row[]>;
  /** Read by the table's sole primary key with optional projection/include. */
  findOne(
    table: AppKitTable,
    id: IdValue,
    spec?: Pick<QuerySpec, "select" | "include">,
  ): Promise<Row | null>;
  count(table: AppKitTable, where?: WhereClause): Promise<number>;
  /** Return exactly one inserted row; zero or many is an invariant failure. */
  insert(table: AppKitTable, values: Row): Promise<Row>;
  /** Return null for zero updated rows and reject more than one. */
  update(table: AppKitTable, id: IdValue, values: Row): Promise<Row | null>;
  /** Return exactly one row for a validated primary-key or unique conflict. */
  upsert(table: AppKitTable, values: Row, onConflict: string): Promise<Row>;
  /** Return false for zero deleted rows, true for one, and reject many. */
  delete(table: AppKitTable, id: IdValue): Promise<boolean>;
  /** Execute tagged SQL whose interpolations are parameter values, not SQL. */
  raw<T = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  /** Run the callback with one transaction-bound DataPath. */
  transaction<T>(callback: (tx: DataPath) => Promise<T>): Promise<T>;
}

/** Runtime failure that does not retain driver details. */
export class DataPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataPathError";
  }
}

/** Validate an explicit root or relation row limit. */
export function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
    throw new DataPathError(
      `limit must be an integer between 0 and ${MAX_LIMIT}`,
    );
  }
  return limit;
}

/** Apply the conservative collection default when no limit is supplied. */
export function limitOrDefault(limit?: number): number {
  return limit === undefined ? DEFAULT_LIMIT : validateLimit(limit);
}

/** Validate an explicit root or relation row offset. */
export function validateOffset(offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw new DataPathError(
      `offset must be an integer between 0 and ${MAX_OFFSET}`,
    );
  }
  return offset;
}

/** Resolve the sole primary key required by keyed operations. */
export function primaryKeyMeta(table: AppKitTable): ColumnMeta {
  const primaryKeys = Object.values(table.$columns).filter(
    (column) => column.primaryKey,
  );
  if (primaryKeys.length !== 1) {
    throw new DataPathError(`Table "${table.$name}" has no primary key`);
  }
  return primaryKeys[0];
}

/** Resolve an upsert target that PostgreSQL can use for conflict detection. */
export function conflictTargetMeta(
  table: AppKitTable,
  columnName: string,
): ColumnMeta {
  const column = table.$columns[columnName];
  if (!column || (!column.primaryKey && !column.unique)) {
    throw new DataPathError(
      `Column "${table.$name}.${columnName}" is not a conflict target`,
    );
  }
  return column;
}
