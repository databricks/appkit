import type { FilterOperator } from "../contract";

declare const ENGINE_TABLE: unique symbol;
declare const ENGINE_COLUMN: unique symbol;
/** Opaque handles keep Drizzle types behind the schema/runtime boundary. */
export type EngineTable = { readonly [ENGINE_TABLE]: true };
export type EngineColumn = { readonly [ENGINE_COLUMN]: true };

/** JavaScript value category exposed by a column, independent of its storage. */
export type ColumnValueKind =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "json"
  | "uuid"
  | "enum"
  | "unknown";

/** The filter subset shared by runtime translation and later typed surfaces. */
export function filterOperatorsForKind(
  kind: ColumnValueKind,
): readonly FilterOperator[] {
  switch (kind) {
    case "string":
      return ["eq", "neq", "in", "like", "ilike"];
    case "number":
    case "bigint":
    case "date":
      return ["eq", "neq", "in", "gt", "gte", "lt", "lte"];
    case "enum":
    case "boolean":
    case "uuid":
      return ["eq", "neq", "in"];
    case "json":
    case "unknown":
      return [];
  }
}

/** PostgreSQL action applied when a referenced row changes or is deleted. */
export type ReferentialAction =
  | "cascade"
  | "set null"
  | "set default"
  | "restrict"
  | "no action";

/** DSL declaration kind, including identity shorthand and unresolved FKs. */
export type ColumnTypeSpec =
  | { readonly kind: "id" }
  | { readonly kind: "bigid" }
  | { readonly kind: "text" }
  | { readonly kind: "varchar"; readonly length: number }
  | { readonly kind: "integer" }
  | { readonly kind: "bigint" }
  | { readonly kind: "boolean" }
  | { readonly kind: "uuid" }
  | { readonly kind: "timestamp"; readonly withTimezone: boolean }
  | { readonly kind: "jsonb" }
  | {
      readonly kind: "enum";
      readonly enumName: string;
      readonly values: readonly string[];
    }
  | { readonly kind: "fk" };

/** Resolved PostgreSQL storage used to construct the engine column. */
export type StorageKind =
  | "id"
  | "bigid"
  | "text"
  | "varchar"
  | "integer"
  | "bigint"
  | "boolean"
  | "uuid"
  | "timestamp"
  | "jsonb"
  | "enum";

export interface ColumnRef {
  readonly __isColumnRef: true;
  readonly tableName: string;
  readonly columnName: string;
}

export type FkRef = ColumnRef | (() => ColumnRef);

export interface ResolvedForeignKey {
  readonly targetTable: string;
  readonly targetColumn: string;
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
}

/** Mutable declaration state. It is cloned per table and never published. */
export interface MutableColumnMeta {
  name: string;
  columnName: string;
  kind: ColumnValueKind;
  storageKind: StorageKind;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  isPrivate: boolean;
  serverGenerated: boolean;
  hasDefault: boolean;
  defaultValue?: string | number | boolean;
  defaultNow?: boolean;
  defaultRandom?: boolean;
  withTimezone?: boolean;
  varcharLength?: number;
  enumName?: string;
  enumValues?: readonly string[];
  fkRef?: FkRef;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  fk?: ResolvedForeignKey;
  engineColumn?: EngineColumn;
}

/** Immutable column metadata published by a finalized schema. */
export type ColumnMeta = Readonly<
  Omit<MutableColumnMeta, "enumValues" | "fk" | "fkRef" | "engineColumn"> & {
    readonly enumValues?: readonly string[];
    readonly fk?: Readonly<ResolvedForeignKey>;
    readonly engineColumn: EngineColumn;
  }
>;

export interface ResolvedRelation {
  readonly name: string;
  readonly cardinality: "toOne" | "toMany";
  readonly localColumn: string;
  readonly targetTable: string;
  readonly targetColumn: string;
  readonly inferred: boolean;
}

export interface AppKitTable {
  readonly $name: string;
  readonly $schemaName: string;
  readonly $columns: Readonly<Record<string, ColumnMeta>>;
  readonly $engine: EngineTable;
  readonly $relations: readonly ResolvedRelation[];
  /** @internal insert schema retained from the current-main foundation. */
  readonly $insertSchema: unknown;
  /** @internal update schema retained from the current-main foundation. */
  readonly $updateSchema: unknown;
}

/** A declaration handle gains finalized table metadata only at publication. */
export type TableHandle<C extends Record<string, unknown>> = AppKitTable & {
  readonly [K in keyof C]: ColumnRef;
};

export interface DefineSchemaOptions {
  readonly schemaName?: string;
}

/**
 * One finalized schema. `TTableName` keeps the declared names in the type, so
 * configuration that addresses a table by name is checked against the schema
 * it was written for. Code that accepts any schema uses the default.
 */
export interface Schema<TTableName extends string = string> {
  readonly $schemaName: string;
  readonly $tables: Readonly<Record<TTableName, AppKitTable>>;
  readonly $engine: Readonly<Record<string, EngineTable>>;
}

export class SchemaBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaBuildError";
  }
}
