import type { MutableColumnMeta, ResolvedRelation } from "./types";
import { SchemaBuildError } from "./types";

interface RelationSourceTable {
  readonly name: string;
  readonly metas: Readonly<Record<string, MutableColumnMeta>>;
}

/** @internal Build the canonical relation metadata before tables are published. */
export function buildRelations(
  tables: ReadonlyMap<string, RelationSourceTable>,
): Map<string, ResolvedRelation[]> {
  const result = new Map<string, ResolvedRelation[]>();
  for (const name of tables.keys()) result.set(name, []);

  // Forward pass: each FK adds a to-one edge to its source table.
  for (const table of tables.values()) {
    const relations = result.get(table.name);
    if (!relations)
      throw new SchemaBuildError("Relation table is not registered");
    const columnNames = new Set(Object.keys(table.metas));
    const seenTargets = new Set<string>();

    for (const meta of Object.values(table.metas)) {
      if (!meta.fk) continue;
      const relationName = meta.fk.targetTable;
      if (columnNames.has(relationName)) {
        throw new SchemaBuildError(
          `Forward relation "${table.name}.${relationName}" collides with a column of the same name`,
        );
      }
      if (seenTargets.has(relationName)) {
        throw new SchemaBuildError(
          `Ambiguous forward relation "${table.name}.${relationName}": multiple foreign keys target "${relationName}"`,
        );
      }
      seenTargets.add(relationName);
      relations.push({
        name: relationName,
        cardinality: "toOne",
        localColumn: meta.columnName,
        targetTable: relationName,
        targetColumn: meta.fk.targetColumn,
        inferred: false,
      });
    }
  }

  // Reverse pass: each non-self FK adds a to-many edge to its target table.
  for (const table of tables.values()) {
    for (const meta of Object.values(table.metas)) {
      if (!meta.fk || meta.fk.targetTable === table.name) continue;
      const target = tables.get(meta.fk.targetTable);
      const targetRelations = result.get(meta.fk.targetTable);
      if (!target || !targetRelations) {
        throw new SchemaBuildError(
          `Relation target "${meta.fk.targetTable}" is not part of the schema`,
        );
      }

      const relationName = table.name;
      if (Object.hasOwn(target.metas, relationName)) {
        throw new SchemaBuildError(
          `Reverse relation "${target.name}.${relationName}" collides with a column of the same name`,
        );
      }
      if (targetRelations.some((relation) => relation.name === relationName)) {
        throw new SchemaBuildError(
          `Reverse relation "${target.name}.${relationName}" is ambiguous`,
        );
      }
      // Reverse edges deliberately retain their stable to-many result shape.
      targetRelations.push({
        name: relationName,
        cardinality: "toMany",
        localColumn: meta.fk.targetColumn,
        targetTable: table.name,
        targetColumn: meta.columnName,
        inferred: true,
      });
    }
  }

  return result;
}
