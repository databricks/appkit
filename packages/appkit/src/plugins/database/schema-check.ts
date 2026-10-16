import { databaseSetupFailed } from "../../database/errors";
import type { DataPath } from "../../database/runtime";
import type { Schema } from "../../database/schema-builder";

interface CatalogColumn {
  readonly table_name: string;
  readonly column_name: string | null;
  readonly relation_kind: string;
}

/**
 * Every declared table or column the database lacks, and every declared table
 * that is a view or another non-table relation, as human-readable problems.
 * pg_catalog is read rather than information_schema, which hides objects the
 * role cannot access and would report a privilege gap as a missing column.
 */
export async function findSchemaProblems(
  dataPath: Pick<DataPath, "raw">,
  schema: Schema,
): Promise<string[]> {
  const tables = Object.values(schema.$tables);
  if (tables.length === 0) return [];
  const schemaName = schema.$schemaName;
  const tableNames = tables.map((table) => table.$name);
  // Include non-tables so setup can report their kind instead of claiming they are absent.
  const rows = await dataPath.raw<CatalogColumn>`
    select c.relname::text as table_name, a.attname::text as column_name,
      c.relkind::text as relation_kind
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_attribute a
      on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname::text = ${schemaName}
      and c.relname::text = any(${tableNames}::text[])
      and c.relkind in ('r', 'p', 'v', 'm', 'f')`;

  const found = new Map<string, { kind: string; columns: Set<string> }>();
  for (const row of rows) {
    const relation = found.get(row.table_name) ?? {
      kind: row.relation_kind,
      columns: new Set<string>(),
    };
    if (row.column_name) relation.columns.add(row.column_name);
    found.set(row.table_name, relation);
  }

  const problems: string[] = [];
  for (const table of tables) {
    const qualified = `${schemaName}.${table.$name}`;
    const relation = found.get(table.$name);
    if (!relation) {
      problems.push(`table ${qualified} does not exist`);
      continue;
    }
    if (relation.kind !== "r" && relation.kind !== "p") {
      const kind =
        relation.kind === "v"
          ? "view"
          : relation.kind === "m"
            ? "materialized view"
            : relation.kind === "f"
              ? "foreign table"
              : "non-table relation";
      problems.push(`table ${qualified} is a ${kind}, not a table`);
      continue;
    }
    const missing = Object.values(table.$columns)
      .map((meta) => meta.columnName)
      .filter((name) => !relation.columns.has(name));
    if (missing.length > 0) {
      problems.push(
        `table ${qualified} is missing ${missing.length === 1 ? "column" : "columns"} ${missing.join(", ")}`,
      );
    }
  }
  return problems;
}

/**
 * Confirm every declared table and column exists before routes are published.
 * Even after a deployed app applies its migrations, drift would surface on each
 * request as an undefined-table or undefined-column failure, so check up front.
 */
export async function assertSchemaMatchesDatabase(
  dataPath: DataPath,
  schema: Schema,
): Promise<void> {
  const problems = await findSchemaProblems(dataPath, schema);
  if (problems.length > 0) {
    throw databaseSetupFailed(
      `the declared schema does not match the database: ${problems.join("; ")}. Run \`npx appkit db migrate\` locally, or commit migrations under config/database/migrations so the deployed app applies them on start.`,
    );
  }
}
