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

// Build resolved `$relations` from column metadata.
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

/** Rebuild `$relations` after `defineSchema` resolves cross-table deferred refs. */
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

/** Build an AppKit table from columns + a Drizzle table factory. */
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

  // PKs go in the URL on PATCH /:id — accepting them in the body lets a caller
  // mutate a row's identity. Drop from the update validator.
  const updateMask: Record<string, true> = { ...privateMask };
  for (const [columnName, definition] of Object.entries(columns)) {
    if (definition.$meta.primaryKey) updateMask[columnName] = true;
  }

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
      Object.keys(updateMask).length > 0
        ? (updateSchema as unknown as z.ZodObject<z.ZodRawShape>).omit(
            updateMask as never,
          )
        : updateSchema,
  };
}

/**
 * Wire deferred `fk()` metadata into Drizzle's `.references()`. `fk()` can run
 * before the target table exists, so it stores the AppKit column first; once
 * the target is built, its `drizzleColumn` is what drizzle-kit needs to emit
 * real FK constraints in migrations.
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
