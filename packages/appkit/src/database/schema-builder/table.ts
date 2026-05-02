import type { pgSchema } from "drizzle-orm/pg-core";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import {
  APPKIT_TABLE,
  type AppKitColumn,
  type AppKitTable,
  type Relation,
} from "./types";

/**
 * Build a table. Returns an AppKit table object that can be used to define the table schema and relationships.
 * @param schemaInstance - The schema instance.
 * @param name - The name of the table.
 * @param columns - The columns of the table.
 * @returns The built table.
 */
export function buildTable<
  TName extends string,
  TCols extends Record<string, AppKitColumn>,
>(
  schemaInstance: ReturnType<typeof pgSchema>,
  name: TName,
  columns: TCols,
): AppKitTable<TName> {
  for (const [columnName, column] of Object.entries(columns)) {
    column.$meta.tableName = name;
    column.$meta.columnName = columnName;
  }

  const drizzleColumns = Object.fromEntries(
    Object.entries(columns).map(([columnName, definition]) => [
      columnName,
      definition.$builder,
    ]),
  );

  const drizzleTable = schemaInstance.table(name, drizzleColumns as never);

  const $columns = Object.fromEntries(
    Object.entries(columns).map(([columnName, definition]) => [
      columnName,
      definition.$meta,
    ]),
  );

  const $relations: Relation[] = Object.entries(columns)
    .map(([columnName, definition]): Relation | null => {
      const reference = definition.$meta.references;
      if (!reference?.toTable || !reference?.toColumn) return null;
      const relation: Relation = {
        fromColumn: columnName,
        toTable: reference.toTable,
        toColumn: reference.toColumn,
      };
      if (reference.onDelete) relation.onDelete = reference.onDelete;
      if (reference.onUpdate) relation.onUpdate = reference.onUpdate;
      return relation;
    })
    .filter((relation): relation is Relation => relation !== null);

  return {
    [APPKIT_TABLE]: true,
    name,
    $drizzle: drizzleTable,
    $columns,
    $relations,
    $insertSchema: createInsertSchema(drizzleTable as never),
    $updateSchema: createUpdateSchema(drizzleTable as never),
  };
}
