import { pgSchema, pgTable } from "drizzle-orm/pg-core";
import { ValidationError } from "../../errors";
import { enumColumn } from "./columns";
import { buildTable, rebuildRelationsFromColumns } from "./table";
import {
  APPKIT_TABLE,
  type AppKitTable,
  type Relation,
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
  const schemaName = options.schemaName ?? "public";
  const schemaInstance =
    schemaName === "public" ? { table: pgTable } : pgSchema(schemaName);

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

  // Resolve any deferred FK targets now that all tables have been built and column names stamped.
  for (const table of Object.values(tableMap)) {
    let touched = false;
    for (const [columnName, columnMeta] of Object.entries(table.$columns)) {
      const reference = columnMeta.references;
      if (!reference?.target) continue;
      if (reference.toTable && reference.toColumn) continue;
      const targetTable = reference.target.$meta.tableName;
      const targetColumn = reference.target.$meta.columnName;
      if (!targetTable || !targetColumn) {
        throw new ValidationError(
          `fk() target on ${table.name}.${columnName} was not declared via table(...). ` +
            `Pass the target column to table() before referencing it from fk().`,
          { context: { table: table.name, column: columnName } },
        );
      }
      reference.toTable = targetTable;
      reference.toColumn = targetColumn;
      touched = true;
    }
    if (touched) {
      const rebuilt: Relation[] = rebuildRelationsFromColumns(table.$columns);
      // $relations is readonly in the public type but the runtime object is mutable.
      (table as { $relations: Relation[] }).$relations = rebuilt;
    }
  }

  return {
    ...tables,
    $drizzle: schemaInstance,
    $tables: tableMap,
    $migrations: { snapshotHints: undefined },
    $schemaName: schemaName,
  } as Schema<T>;
}
