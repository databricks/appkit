import { type Relation, relations } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { type AppKitTable, SchemaBuildError } from "../types";

function columnOf(table: AppKitTable, name: string): AnyPgColumn {
  const column = table.$columns[name]?.engineColumn;
  if (!column) {
    throw new SchemaBuildError(
      `Engine relation column "${table.$name}.${name}" is not finalized`,
    );
  }
  return column as unknown as AnyPgColumn;
}

/** Adapt finalized relation metadata to Drizzle's relation registration shape. */
export function buildEngineRelations(
  tables: Record<string, AppKitTable>,
): Record<string, unknown> {
  const byName = new Map<string, AppKitTable>();
  for (const table of Object.values(tables)) byName.set(table.$name, table);

  const out: Record<string, unknown> = Object.create(null);

  for (const table of Object.values(tables)) {
    if (table.$relations.length === 0) continue;

    const localEngine = table.$engine as unknown as PgTable;
    out[`${table.$name}Relations`] = relations(localEngine, ({ one, many }) => {
      const config: Record<string, Relation> = Object.create(null);
      for (const relation of table.$relations) {
        const target = byName.get(relation.targetTable);
        if (!target) {
          throw new SchemaBuildError(
            `Engine relation target "${relation.targetTable}" is not finalized`,
          );
        }
        const targetEngine = target.$engine as unknown as PgTable;
        config[relation.name] =
          relation.cardinality === "toOne"
            ? one(targetEngine, {
                fields: [columnOf(table, relation.localColumn)],
                references: [columnOf(target, relation.targetColumn)],
              })
            : many(targetEngine);
      }
      return config;
    });
  }
  return out;
}
