import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import type { z } from "zod";
import {
  APPKIT_TABLE,
  type AppKitColumn,
  type AppKitTable,
  type ColumnMeta,
  type Relation,
} from "./types";

interface TableFactory {
  table: (name: string, columns: never) => unknown;
}

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
  schemaInstance: TableFactory,
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

  for (const definition of Object.values(columns)) {
    applyDrizzleReference(definition);
  }

  const drizzleColumns = Object.fromEntries(
    Object.entries(columns).map(([columnName, definition]) => [
      columnName,
      definition.$builder,
    ]),
  );

  const drizzleTable = schemaInstance.table(name, drizzleColumns as never);

  for (const [columnName, definition] of Object.entries(columns)) {
    definition.$meta.drizzleColumn = (drizzleTable as Record<string, unknown>)[
      columnName
    ];
  }

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

/**
 * Wires deferred `fk()` metadata into Drizzle's native `.references()` API.
 *
 * `fk()` can run before the referenced table exists, so it stores the target
 * AppKit column first. Once a table has been built, the target column metadata
 * contains the concrete Drizzle column, which is the value drizzle-kit needs to
 * generate real foreign-key constraints in migrations.
 */
function applyDrizzleReference(definition: AppKitColumn): void {
  const reference = definition.$meta.references;
  const target = reference?.target;
  const targetDrizzleColumn = target?.$meta.drizzleColumn;
  if (!reference || !target || !targetDrizzleColumn) return;

  const actions: {
    onDelete?: Relation["onDelete"];
    onUpdate?: Relation["onUpdate"];
  } = {};
  if (reference.onDelete) actions.onDelete = reference.onDelete;
  if (reference.onUpdate) actions.onUpdate = reference.onUpdate;

  definition.$builder = (
    definition.$builder as {
      references: (
        ref: () => unknown,
        actions?: {
          onDelete?: Relation["onDelete"];
          onUpdate?: Relation["onUpdate"];
        },
      ) => unknown;
    }
  ).references(
    () => targetDrizzleColumn,
    Object.keys(actions).length ? actions : undefined,
  );
}
