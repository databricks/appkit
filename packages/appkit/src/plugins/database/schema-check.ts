import { databaseSetupFailed } from "../../database/errors";
import type { DataPath } from "../../database/runtime";
import type { Schema } from "../../database/schema-builder";

interface CatalogColumn {
  readonly table_name: string;
  readonly column_name: string | null;
}

/**
 * Confirm every declared table and column exists before routes are published.
 * The plugin never migrates, so drift would otherwise surface on each request
 * as an undefined-table or undefined-column failure. pg_catalog is read rather
 * than information_schema, which hides objects the role cannot access and
 * would report a privilege gap as a missing column.
 */
export async function assertSchemaMatchesDatabase(
  dataPath: DataPath,
  schema: Schema,
): Promise<void> {
  const tables = Object.values(schema.$tables);
  if (tables.length === 0) return;
  const schemaName = schema.$schemaName;
  const tableNames = tables.map((table) => table.$name);
  // Tables, partitioned tables, views, materialized views, and foreign tables.
  const rows = await dataPath.raw<CatalogColumn>`
    select c.relname::text as table_name, a.attname::text as column_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_attribute a
      on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname::text = ${schemaName}
      and c.relname::text = any(${tableNames}::text[])
      and c.relkind in ('r', 'p', 'v', 'm', 'f')`;

  const found = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = found.get(row.table_name) ?? new Set<string>();
    if (row.column_name) columns.add(row.column_name);
    found.set(row.table_name, columns);
  }

  const problems: string[] = [];
  for (const table of tables) {
    const qualified = `${schemaName}.${table.$name}`;
    const columns = found.get(table.$name);
    if (!columns) {
      problems.push(`table ${qualified} does not exist`);
      continue;
    }
    const missing = Object.values(table.$columns)
      .map((meta) => meta.columnName)
      .filter((name) => !columns.has(name));
    if (missing.length > 0) {
      problems.push(
        `table ${qualified} is missing ${missing.length === 1 ? "column" : "columns"} ${missing.join(", ")}`,
      );
    }
  }
  if (problems.length > 0) {
    throw databaseSetupFailed(
      `the declared schema does not match the database: ${problems.join("; ")}. Create or migrate these before starting the app; the plugin does not.`,
    );
  }
}
