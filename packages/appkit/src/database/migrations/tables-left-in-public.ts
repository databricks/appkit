import type { Schema } from "../schema-builder";
import { schemaNameIsExplicit } from "../schema-builder/define-schema";

export type CatalogSql = <T>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<readonly T[]>;

interface CatalogClient {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ readonly rows: readonly unknown[] }>;
}

export function catalogSqlOf(client: CatalogClient): CatalogSql {
  return async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((sql, part, index) => `${sql}$${index}${part}`);
    const { rows } = await client.query(text, values);
    return rows as T[];
  };
}

interface TablePlacement {
  readonly inSchema: readonly string[];
  readonly inPublic: readonly string[];
}

/**
 * Find the named tables in `schemaName` and in `public`. pg_catalog is read
 * rather than information_schema, which hides objects the role cannot access
 * and would report a privilege gap as a missing table.
 */
export async function locateTables(
  sql: CatalogSql,
  schemaName: string,
  tableNames: readonly string[],
): Promise<TablePlacement> {
  if (tableNames.length === 0) return { inSchema: [], inPublic: [] };
  const rows = await sql<{ schema_name: string; table_name: string }>`
    select n.nspname::text as schema_name, c.relname::text as table_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname::text in (${schemaName}, 'public')
      and c.relname::text = any(${tableNames}::text[])
      and c.relkind in ('r', 'p')`;
  const within = (schema: string) => {
    const found = new Set(
      rows
        .filter((row) => row.schema_name === schema)
        .map((row) => row.table_name),
    );
    return tableNames.filter((name) => found.has(name));
  };
  return { inSchema: within(schemaName), inPublic: within("public") };
}

export function keepInPublicAdvice(schemaName: string): string {
  return (
    `defineSchema() puts tables in schema "${schemaName}" unless told otherwise. ` +
    'To keep them in public, pass { schemaName: "public" } as the second argument of defineSchema() in config/database/schema.ts.'
  );
}

export async function detectTablesLeftInPublic(
  sql: CatalogSql,
  schema: Schema,
): Promise<string | undefined> {
  if (schemaNameIsExplicit(schema)) return undefined;
  const schemaName = schema.$schemaName;
  const declared = Object.values(schema.$tables).map((table) => table.$name);
  const { inSchema, inPublic } = await locateTables(sql, schemaName, declared);
  if (inSchema.length > 0 || inPublic.length === 0) return undefined;
  return (
    `none of the declared tables exist in schema "${schemaName}", but public has ${inPublic.join(", ")}. ` +
    `Migrating would create empty copies in "${schemaName}" and the app would serve those. ` +
    `${keepInPublicAdvice(schemaName)} ` +
    `To use schema "${schemaName}", move the tables there first (ALTER TABLE public.<table> SET SCHEMA ${schemaName}), ` +
    `or pass { schemaName: "${schemaName}" } explicitly when the tables in public belong to another app.`
  );
}
