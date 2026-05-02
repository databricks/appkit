import { pgSchema } from "drizzle-orm/pg-core";
import { enumColumn } from "./columns";
import { buildTable } from "./table";
import {
  APPKIT_TABLE,
  type AppKitTable,
  type Schema,
  type SchemaBuilderContext,
} from "./types";

/**
 * Options for defining a schema.
 */
export interface DefineSchemaOptions {
  schemaName?: string;
}

/**
 * Define a schema. This is used to build the schema for the database.
 * @param build - A function that builds the schema.
 * @param options - Options for defining the schema.
 * @returns The defined schema.
 */
export function defineSchema<T extends Record<string, AppKitTable>>(
  build: (ctx: SchemaBuilderContext) => T,
  options: DefineSchemaOptions = {},
): Schema<T> {
  const schemaInstance = pgSchema(options.schemaName ?? "app");

  const context: SchemaBuilderContext = {
    table: (name, columns) => buildTable(schemaInstance, name, columns),
    enum: (name, values) => enumColumn(name, values),
  };

  const tables = build(context);
  const tableMap: Record<string, AppKitTable> = {};
  for (const [key, value] of Object.entries(tables)) {
    if ((value as AppKitTable)[APPKIT_TABLE]) {
      tableMap[key] = value as AppKitTable;
    }
  }

  return {
    ...tables,
    $drizzle: schemaInstance,
    $tables: tableMap,
    $migrations: { snapshotHints: undefined },
  } as Schema<T>;
}
