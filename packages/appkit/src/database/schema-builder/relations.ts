import { type AppKitTable, SchemaBuildError } from "./types";

export function buildRelations(tables: Record<string, AppKitTable>) {
  for (const table of Object.values(tables)) {
    const columnNames = new Set(Object.keys(table.$columns));
    const seenForward = new Set<string>();

    for (const meta of Object.values(table.$columns)) {
      if (!meta.fk) continue;

      const name = meta.fk.targetTable;
      if (columnNames.has(name))
        throw new SchemaBuildError(
          `Forward relation "${table.$name}.${name}" collides with a column of the same name`,
        );

      if (seenForward.has(name))
        throw new SchemaBuildError(
          `Ambiguous forward relation "${table.$name}.${name}": multiple foreign keys target "${name}". Rename one target or model the relation explicitly.`,
        );
      seenForward.add(name);
      table.$relations.push({
        name,
        cardinality: "toOne",
        localColumn: meta.columnName,
        targetTable: name,
        targetColumn: meta.fk.targetColumn,
        inferred: false,
      });
    }
  }

  for (const table of Object.values(tables)) {
    for (const meta of Object.values(table.$columns)) {
      if (!meta.fk) continue;
      const targetTable = tables[meta.fk.targetTable];
      if (!targetTable) continue;

      // Skip self-referential relations.
      if (targetTable === table) continue;

      const name = table.$name;
      if (Object.keys(targetTable.$columns).includes(name))
        throw new SchemaBuildError(
          `Reverse relation "${targetTable.$name}.${name}" collides with a column of the same name`,
        );

      if (targetTable.$relations.some((r) => r.name === name))
        throw new SchemaBuildError(
          `Reverse relation "${targetTable.$name}.${name}" is ambiguous (multiple foreign keys from "${table.$name}"). Disambiguate by renaming the source table.`,
        );

      targetTable.$relations.push({
        name,
        cardinality: "toMany",
        localColumn: meta.fk.targetColumn,
        targetTable: table.$name,
        targetColumn: meta.columnName,
        inferred: true,
      });
    }
  }
}
