import type { IntrospectedColumn, IntrospectedTable } from "./types";

/**
 * Infer foreign keys from naming convention for databases that lack declared
 * FK constraints. A column on table T is linked to table T' when:
 *   - T has no existing `references` on that column
 *   - the column is not the canonical PK of T (e.g. `cases.case_id` stays put)
 *   - T' (other than T) has a same-named primary-key column with the same
 *     `pgType`, and either there is exactly one such candidate, or a single
 *     candidate's table name matches the column's `_id` prefix (singular or
 *     simple plural) so the tiebreaker is unambiguous.
 *
 * Inferred references carry `inferred: true` so the renderer can mark them
 * for human review. Cases that remain ambiguous after the tiebreaker are
 * skipped on purpose — a wrong FK is worse than a missing one.
 */
export function inferRelationsByConvention(tables: IntrospectedTable[]): void {
  const pkIndex = buildPrimaryKeyIndex(tables);

  for (const table of tables) {
    for (const column of table.columns) {
      if (column.references) continue;
      if (isCanonicalPrimaryKey(table, column)) continue;

      const candidates = (pkIndex.get(column.name) ?? []).filter(
        (entry) =>
          entry.table.name !== table.name &&
          entry.column.pgType === column.pgType,
      );
      if (candidates.length === 0) continue;

      const chosen = chooseCandidate(column.name, candidates);
      if (!chosen) continue;

      column.references = {
        schema: chosen.table.schema,
        table: chosen.table.name,
        column: chosen.column.name,
        inferred: true,
      };
    }
  }
}

interface PrimaryKeyEntry {
  table: IntrospectedTable;
  column: IntrospectedColumn;
}

function buildPrimaryKeyIndex(
  tables: IntrospectedTable[],
): Map<string, PrimaryKeyEntry[]> {
  const index = new Map<string, PrimaryKeyEntry[]>();
  for (const table of tables) {
    for (const column of table.columns) {
      if (!column.isPrimaryKey) continue;
      const list = index.get(column.name);
      if (list) list.push({ table, column });
      else index.set(column.name, [{ table, column }]);
    }
  }
  return index;
}

/**
 * `cases.case_id` is the canonical PK of `cases`; never treat it as an FK
 * candidate. Detected when the column name's `_id` prefix matches the table
 * name (singular or simple plural).
 */
function isCanonicalPrimaryKey(
  table: IntrospectedTable,
  column: IntrospectedColumn,
): boolean {
  if (!column.isPrimaryKey) return false;
  const base = stripIdSuffix(column.name);
  if (base === null) return false;
  return tableNameMatchesBase(table.name, base);
}

function chooseCandidate(
  columnName: string,
  candidates: PrimaryKeyEntry[],
): PrimaryKeyEntry | undefined {
  if (candidates.length === 1) return candidates[0];

  const base = stripIdSuffix(columnName);
  if (base === null) return undefined;

  const byName = candidates.filter((entry) =>
    tableNameMatchesBase(entry.table.name, base),
  );
  return byName.length === 1 ? byName[0] : undefined;
}

function stripIdSuffix(name: string): string | null {
  return name.endsWith("_id") ? name.slice(0, -3) : null;
}

/**
 * Match `case` against `cases`, `category` against `categories`, `address`
 * against `addresses`. Conservative — anything fancier (irregular plurals,
 * snake_case multi-word singularization) intentionally falls through so we
 * don't guess wrong.
 */
function tableNameMatchesBase(tableName: string, base: string): boolean {
  if (tableName === base) return true;
  if (tableName === `${base}s`) return true;
  if (tableName === `${base}es`) return true;
  if (tableName.endsWith("ies") && `${tableName.slice(0, -3)}y` === base) {
    return true;
  }
  return false;
}
