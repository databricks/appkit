import type { pgSchema } from "drizzle-orm/pg-core";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import type { z } from "zod";
import {
  APPKIT_TABLE,
  type AppKitColumn,
  type AppKitTable,
  type ColumnMeta,
  type Relation,
} from "./types";

/**
 * Build the resolved `$relations` list for a table from its column metadata.
 */
function buildRelations(columns: Record<string, AppKitColumn>): Relation[] {
  const relations: Relation[] = [];
  for (const [columnName, column] of Object.entries(columns)) {
    const reference = column.$meta.references;
    if (!reference?.toTable || !reference?.toColumn) continue;
    const relation: Relation = {
      fromColumn: columnName,
      toTable: reference.toTable,
      toColumn: reference.toColumn,
    };
    if (reference.onDelete) relation.onDelete = reference.onDelete;
    if (reference.onUpdate) relation.onUpdate = reference.onUpdate;
    relations.push(relation);
  }
  return relations;
}

/**
 * Rebuild `$relations` from the column-meta map.
 * Used by `defineSchema` after resolving cross-table deferred references.
 */
export function rebuildRelationsFromColumns(
  columnMetas: Record<string, ColumnMeta>,
): Relation[] {
  const relations: Relation[] = [];
  for (const [columnName, meta] of Object.entries(columnMetas)) {
    const reference = meta.references;
    if (!reference?.toTable || !reference?.toColumn) continue;
    const relation: Relation = {
      fromColumn: columnName,
      toTable: reference.toTable,
      toColumn: reference.toColumn,
    };
    if (reference.onDelete) relation.onDelete = reference.onDelete;
    if (reference.onUpdate) relation.onUpdate = reference.onUpdate;
    relations.push(relation);
  }
  return relations;
}

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

  // Resolve any self-FK targets now that names on this table are stamped.
  for (const column of Object.values(columns)) {
    const reference = column.$meta.references;
    if (!reference?.target) continue;
    if (reference.toTable && reference.toColumn) continue;
    const targetTable = reference.target.$meta.tableName;
    const targetColumn = reference.target.$meta.columnName;
    if (targetTable === name && targetColumn) {
      reference.toTable = targetTable;
      reference.toColumn = targetColumn;
    }
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

  const $relations: Relation[] = buildRelations(columns);

  const privateMask = Object.fromEntries(
    Object.entries(columns)
      .filter(([, definition]) => definition.$meta.private === true)
      .map(([columnName]) => [columnName, true as const]),
  );

  const insertSchema = createInsertSchema(drizzleTable as never);
  const updateSchema = createUpdateSchema(drizzleTable as never);

  return {
    [APPKIT_TABLE]: true,
    name,
    $drizzle: drizzleTable,
    $columns,
    $relations,
    $insertSchema:
      Object.keys(privateMask).length > 0
        ? (insertSchema as unknown as z.ZodObject<z.ZodRawShape>).omit(
            privateMask as never,
          )
        : insertSchema,
    $updateSchema:
      Object.keys(privateMask).length > 0
        ? (updateSchema as unknown as z.ZodObject<z.ZodRawShape>).omit(
            privateMask as never,
          )
        : updateSchema,
  };
}
