import { DEFAULT_LIMIT, type FilterOperator, MAX_LIMIT } from "../contract";
import type { AppKitTable, ColumnMeta } from "../schema-builder";

export type IdValue = string | number;
export type ScalarValue = string | number | boolean | null;

/** Operator object form, e.g. `{ eq: 1, gt: [2, 3] }` */
export type FilterOps = Partial<
  Record<FilterOperator, ScalarValue | ScalarValue[]>
>;

export type WhereValue =
  | ScalarValue
  | ScalarValue[]
  | FilterOps
  | RelationPredicate;
export type WhereClause = Record<string, WhereValue | WhereClause[]>;

/** Relation predicate: `{ some: {...} }` → EXISTS, `{ none: {...} }` → NOT EXISTS. */
export interface RelationPredicate {
  some?: WhereClause;
  none?: WhereClause;
}

export type OrderDirection = "asc" | "desc";
export type OrderSpec = Record<string, OrderDirection>;

export interface IncludeOptions {
  select?: string[];
  where?: WhereClause;
  order?: OrderSpec;
  limit?: number;
}

export type IncludeSpec = Record<string, boolean | IncludeOptions>;

export interface QuerySpec {
  where?: WhereClause;
  order?: OrderSpec;
  select?: string[];
  include?: IncludeSpec;
  limit?: number;
  offset?: number;
}

export type Row = Record<string, unknown>;

/** Backend-agnostic data access. */
export interface DataPath {
  select(table: AppKitTable, spec: QuerySpec): Promise<Row[]>;
  findOne(
    table: AppKitTable,
    id: IdValue,
    spec?: Pick<QuerySpec, "select" | "include">,
  ): Promise<Row | null>;
  count(table: AppKitTable, where?: WhereClause): Promise<number>;
  insert(table: AppKitTable, values: Row): Promise<Row>;
  update(table: AppKitTable, id: IdValue, values: Row): Promise<Row | null>;
  upsert(table: AppKitTable, values: Row, onConflict: string[]): Promise<Row>;
  delete(table: AppKitTable, id: IdValue): Promise<boolean>;
  getColumn(table: AppKitTable, id: IdValue, column: string): Promise<unknown>;
  raw<T = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  transaction<T>(fn: (tx: DataPath) => Promise<T>): Promise<T>;
}

export class DataPathError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "DataPathError";
    this.statusCode = statusCode;
  }
}

export function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new DataPathError("limit must be a non-negative integer");
  }

  return Math.min(limit, MAX_LIMIT);
}

export function limitOrDefault(limit?: number): number {
  return limit === undefined ? DEFAULT_LIMIT : clampLimit(limit);
}

export function primaryKeyMeta(table: AppKitTable): ColumnMeta {
  const pk = Object.values(table.$columns).find((c) => c.primaryKey);
  if (!pk)
    throw new DataPathError(`Table "${table.$name}" has no primary key`, 500);

  return pk;
}

export function isRelationPredicate(
  value: unknown,
): value is RelationPredicate {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("some" in value || "none" in value)
  );
}
