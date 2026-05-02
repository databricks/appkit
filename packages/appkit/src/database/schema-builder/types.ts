import type { z } from "zod";

/**
 * Symbol for identifying AppKit table metadata.
 */
export const APPKIT_TABLE = Symbol.for("appkit.database.table");

/**
 * Metadata for an AppKit column. This is used to store the column metadata in the schema.
 * @example
 * ```ts
 * const columnMeta: ColumnMeta = {
 *   serverGenerated: true,
 * };
 * ```
 */
export interface ColumnMeta {
  serverGenerated?: boolean;
  /** @internal */
  tableName?: string;
  /** @internal */
  columnName?: string;
  /** @internal */
  references?: Pick<Relation, "toTable" | "toColumn" | "onDelete" | "onUpdate">;
}

/**
 * An AppKit column. This is returned by the column builder methods.
 * @example
 * ```ts
 * const column: AppKitColumn = {
 *   $builder: unknown,
 *   $meta: columnMeta,
 * };
 * ```
 */
export interface AppKitColumn {
  $builder: unknown;
  $meta: ColumnMeta;
}

/**
 * A chain of AppKit column methods. This is returned by the column builder methods.
 * @example
 * ```ts
 * const column: AppKitColumnChain = {
 *   $builder: unknown,
 *   $meta: columnMeta,
 * };
 * ```
 */
export interface AppKitColumnChain extends AppKitColumn {
  notNull(): AppKitColumnChain;
  unique(): AppKitColumnChain;
  primaryKey(): AppKitColumnChain;
  default<T>(value: T): AppKitColumnChain;
  defaultNow(): AppKitColumnChain;
  defaultRandom(): AppKitColumnChain;
}

/**
 * A relation between two tables. This is used to define the foreign key relationships between tables.
 * @example
 * ```ts
 * const relation: Relation = {
 *   fromColumn: "userId",
 *   toTable: "users",
 *   toColumn: "id",
 *   onDelete: "cascade",
 *   onUpdate: "cascade",
 * };
 * ```
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
 * @example
 * ```ts
 * const table: AppKitTable = {
 *   $builder: unknown,
 *   $meta: tableMeta,
 * };
 * ```
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
 * @example
 * ```ts
 * const schema: Schema = {
 *   $drizzle: unknown,
 *   $tables: { tableName: AppKitTable },
 *   $migrations: { snapshotHints: unknown },
 * };
 * ```
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
 * @example
 * ```ts
 * const context: SchemaBuilderContext = {
 *   table: (name, columns) => table(name, columns),
 *   enum: (name, values) => enum(name, values),
 * };
 * ```
 */
export interface SchemaBuilderContext {
  table: <TName extends string, TCols extends Record<string, AppKitColumn>>(
    name: TName,
    columns: TCols,
  ) => AppKitTable<TName>;
  enum: (name: string, values: readonly string[]) => AppKitColumnChain;
}
