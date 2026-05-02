import type { z } from "zod";

/**
 * Symbol for identifying AppKit table metadata.
 */
export const APPKIT_TABLE = Symbol.for("appkit.database.table");

/**
 * Source pg type tag stamped by each column helper. `fk()` reads it from the
 * target column to mirror the type instead of hardcoding `integer`.
 */
export type ColumnKind =
  | "text"
  | "varchar"
  | "uuid"
  | "integer"
  | "bigint"
  | "serial"
  | "bigserial"
  | "boolean"
  | "jsonb"
  | "timestamp"
  | "enum";

/**
 * Metadata for an AppKit column. This is used to store the column metadata in the schema.
 */
export interface ColumnMeta {
  serverGenerated?: boolean;
  primaryKey?: boolean;
  /**
   * Marks this column as private.
   * Excludes the column from the generated `$insertSchema` and `$updateSchema` (i.e. blocks writes through the validators).
   */
  private?: boolean;
  /** @internal Source pg type tag — used by `fk()` to mirror target type. */
  pgKind?: ColumnKind;
  /** @internal */
  tableName?: string;
  /** @internal */
  columnName?: string;
  /** @internal Drizzle column ref attached at table-build time, used by introspector. */
  drizzleColumn?: unknown;
  /**
   * @internal Foreign-key reference. Two states: **deferred** (`target` set
   * before table assembly) or **resolved** (`toTable`/`toColumn` populated).
   */
  references?: {
    target?: AppKitColumn;
    toTable?: string;
    toColumn?: string;
    onDelete?: Relation["onDelete"];
    onUpdate?: Relation["onUpdate"];
  };
}

/**
 * An AppKit column. This is returned by the column builder methods.
 */
export interface AppKitColumn {
  $builder: unknown;
  $meta: ColumnMeta;
}

/**
 * A chain of AppKit column methods. This is returned by the column builder methods.
 */
export interface AppKitColumnChain extends AppKitColumn {
  notNull(): AppKitColumnChain;
  unique(): AppKitColumnChain;
  primaryKey(): AppKitColumnChain;
  default<T>(value: T): AppKitColumnChain;
  defaultNow(): AppKitColumnChain;
  defaultRandom(): AppKitColumnChain;
  private(): AppKitColumnChain;
}

/**
 * A foreign-key column chain. Returned by `fk(target)`.
 */
export interface FkColumnChain extends AppKitColumnChain {
  notNull(): FkColumnChain;
  unique(): FkColumnChain;
  primaryKey(): FkColumnChain;
  default<T>(value: T): FkColumnChain;
  defaultNow(): FkColumnChain;
  defaultRandom(): FkColumnChain;
  private(): FkColumnChain;
  onDelete(value: NonNullable<Relation["onDelete"]>): FkColumnChain;
  onUpdate(value: NonNullable<Relation["onUpdate"]>): FkColumnChain;
}

/**
 * A relation between two tables. This is used to define the foreign key relationships between tables.
 */
export interface Relation {
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete?: "cascade" | "set null" | "restrict" | "no action";
  onUpdate?: "cascade" | "set null" | "restrict" | "no action";
}

/**
 * An AppKit table. This is returned by the table builder methods.
 * This is used to define the table schema and relationships.
 */
export interface AppKitTable<TName extends string = string> {
  readonly [APPKIT_TABLE]: true;
  readonly name: TName;
  readonly $drizzle: unknown;
  readonly $columns: Record<string, ColumnMeta>;
  readonly $insertSchema: z.ZodTypeAny;
  readonly $updateSchema: z.ZodTypeAny;
  readonly $relations: Relation[];
}

/**
 * A schema. This is used to define the schema for the database.
 */
export type Schema<
  T extends Record<string, unknown> = Record<string, unknown>,
> = T & {
  readonly $drizzle: unknown;
  readonly $tables: Record<string, AppKitTable>;
  readonly $migrations: { snapshotHints: unknown };
};

/**
 * A context for the schema builder. This is used to build the schema.
 */
export interface SchemaBuilderContext {
  table: <TName extends string, TCols extends Record<string, AppKitColumn>>(
    name: TName,
    columns: TCols,
  ) => AppKitTable<TName>;
  enum: (name: string, values: readonly string[]) => AppKitColumnChain;
}
