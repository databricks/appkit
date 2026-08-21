import { type Relation, relations } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { AppKitTable } from "../types";

function columnOf(table: PgTable, name: string): AnyPgColumn {
  const col = (table as unknown as Record<string, unknown>)[name];
  if (!col)
    throw new Error(`engine relations: column "${name}" not found on table`);
  return col as AnyPgColumn;
}

export function buildEngineRelations(
  tables: Record<string, AppKitTable>,
): Record<string, unknown> {
  const byName = new Map<string, AppKitTable>();
  for (const table of Object.values(tables)) byName.set(table.$name, table);

  const out: Record<string, unknown> = {};

  for (const table of Object.values(tables)) {
    if (table.$relations.length === 0) continue;

    const localEngine = table.$engine as unknown as PgTable;
    out[`${table.$name}Relations`] = relations(localEngine, ({ one, many }) => {
      const config: Record<string, Relation> = {};
      for (const relation of table.$relations) {
        const target = byName.get(relation.targetTable);
        if (!target) continue;
        const targetEngine = target.$engine as unknown as PgTable;
        config[relation.name] =
          relation.cardinality === "toOne"
            ? one(targetEngine, {
                fields: [columnOf(localEngine, relation.localColumn)],
                references: [columnOf(targetEngine, relation.targetColumn)],
              })
            : many(targetEngine);
      }
      return config;
    });
  }
  return out;
}
