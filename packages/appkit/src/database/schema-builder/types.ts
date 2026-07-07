import type { ColumnInfoKind, ReferentialAction } from "../contract";

/**
 * Opaque handles to the internal query-engine objects.
 */
declare const ENGINE_TABLE: unique symbol;
declare const ENGINE_COLUMN: unique symbol;
export type EngineTable = { readonly [ENGINE_TABLE]: true };
export type EngineColumn = { readonly [ENGINE_COLUMN]: true };

/** Internal description of a column's storage type */
export type ColumnTypeSpec =
  | { kind: "id" }
  | { kind: "bigid" }
  | { kind: "text" }
  | { kind: "varchar"; length: number }
  | { kind: "integer" }
  | { kind: "bigint" }
  | { kind: "boolean" }
  | { kind: "uuid" }
  | { kind: "timestamp"; withTimezone: boolean }
  | { kind: "jsonb" }
  | { kind: "enum"; enumName: string; values: readonly string[] }
  | { kind: "fk" };

/** Concrete storage kind after FK mirroring */
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

/** A deferred or direct reference to a target column */
export interface ColumnRef {
  readonly __isColumnRef: true;
  readonly tableName: string;
  readonly columnName: string;
}

export type FkRef = ColumnRef | (() => ColumnRef);

/** Mutable working metadata; frozen into {@link ColumnMeta} at the end of the build. */
export interface MutableColumnMeta {
  name: string;
  columnName: string;
  kind: ColumnInfoKind;
  pgType: string;
  storageKind: StorageKind;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  isPrivate: boolean;
  /** RLS owner column (`.owner()`) — its email value is compared to current_user_email() by the policy. */
  isOwner: boolean;
  serverGenerated: boolean;
  hasDefault: boolean;
  defaultExpr?: string;
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
  fk?: {
    targetTable: string;
    targetColumn: string;
    onDelete?: ReferentialAction;
    onUpdate?: ReferentialAction;
  };
  /** @internal opaque engine column handle */
  engineColumn?: EngineColumn;
}

/** Resolved, read-only column metadata exposed on a built table. */
export type ColumnMeta = Readonly<MutableColumnMeta>;

/**
 * A named, directed relation resolved from FK edges. `toOne` is the forward
 * many-to-one; `toMany` is the inferred reverse one-to-many.
 */
export interface ResolvedRelation {
  name: string;
  cardinality: "toOne" | "toMany";
  localColumn: string;
  targetTable: string;
  targetColumn: string;
  inferred: boolean;
}

/** A built table: the engine table handle plus AppKit metadata under `$`-keys. */
export interface AppKitTable {
  $name: string;
  $schemaName: string;
  $columns: Record<string, ColumnMeta>;
  /** @internal opaque engine table handle */
  $engine: EngineTable;
  $relations: ResolvedRelation[];
  /** @internal insert schema */
  $insertSchema?: unknown;
  /** @internal update schema */
  $updateSchema?: unknown;
}

/** The object returned by `ctx.table(...)`: column refs + (after build) the table metadata. */
export type TableHandle<C extends Record<string, unknown>> = AppKitTable & {
  readonly [K in keyof C]: ColumnRef;
};

export interface DefineSchemaOptions {
  /** Postgres schema name; canonical default is `"public"`. */
  schemaName?: string;
}

export interface Schema {
  $schemaName: string;
  $tables: Record<string, AppKitTable>;
  /** @internal opaque engine table handles */
  $engine: Record<string, EngineTable>;
}

export class SchemaBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaBuildError";
  }
}
