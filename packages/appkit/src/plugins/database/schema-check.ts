import { databaseSetupFailed } from "../../database/errors";
import {
  INSUFFICIENT_PRIVILEGE,
  ownershipHint,
} from "../../database/migrations/ownership";
import {
  keepInPublicAdvice,
  locateTables,
} from "../../database/migrations/tables-left-in-public";
import type { DataPath } from "../../database/runtime";
import type { Schema } from "../../database/schema-builder";
import { schemaNameIsExplicit } from "../../database/schema-builder/define-schema";
import type { MigrateOnStartDecision } from "./migrate-on-start";

interface CatalogColumn {
  readonly table_name: string;
  readonly column_name: string | null;
  readonly relation_kind: string;
}

interface SchemaAccess {
  readonly owner: string;
  readonly current_user: string;
  readonly usage: boolean;
  readonly can_create: boolean;
}

/**
 * pg_catalog lists the tables of a schema the role has no USAGE on, so the
 * check below would pass and every request would fail with 42501.
 */
async function assertSchemaUsable(
  dataPath: DataPath,
  schemaName: string,
): Promise<void> {
  const [access] = await dataPath.raw<SchemaAccess>`
    select pg_catalog.pg_get_userbyid(n.nspowner)::text as owner,
      current_user::text as current_user,
      pg_catalog.has_schema_privilege(n.oid, 'USAGE') as usage,
      pg_catalog.has_schema_privilege(n.oid, 'CREATE') as can_create
    from pg_catalog.pg_namespace n
    where n.nspname::text = ${schemaName}`;
  if (!access || access.usage) return;
  const hint = ownershipHint(INSUFFICIENT_PRIVILEGE, {
    schemaName,
    owner: access.owner,
    currentUser: access.current_user,
    canCreate: access.can_create,
  });
  throw databaseSetupFailed(
    `role "${access.current_user}" has no USAGE on schema "${schemaName}". ${hint}`,
  );
}

function migrationAdvice(migration: MigrateOnStartDecision): string {
  switch (migration.kind) {
    case "off":
      return "Create them, or commit migrations under config/database/migrations and set APPKIT_DB_MIGRATE_ON_START=true in app.yaml so the deployed app applies them on start.";
    case "skipped":
      return "APPKIT_DB_MIGRATE_ON_START is true, but this process did not migrate on start. The warning logged before this error says why.";
    case "migrate":
      return "The committed migrations under config/database/migrations were applied on start and leave them missing. Commit a migration that creates them and deploy again.";
  }
}

/**
 * Confirm every declared table and column exists before routes are published.
 * pg_catalog is read rather than information_schema, which hides objects the
 * role cannot access and would report a privilege gap as a missing column.
 */
export async function assertSchemaMatchesDatabase(
  dataPath: DataPath,
  schema: Schema,
  migration: MigrateOnStartDecision,
): Promise<void> {
  const tables = Object.values(schema.$tables);
  if (tables.length === 0) return;
  const schemaName = schema.$schemaName;
  await assertSchemaUsable(dataPath, schemaName);
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
  if (problems.length > 0) {
    const absent = tableNames.filter((name) => !found.has(name));
    const advice =
      (await inPublicInstead(dataPath, schema, absent)) ??
      migrationAdvice(migration);
    throw databaseSetupFailed(
      `the declared schema does not match the database: ${problems.join("; ")}. ${advice}`,
    );
  }
}

async function inPublicInstead(
  dataPath: DataPath,
  schema: Schema,
  absent: readonly string[],
): Promise<string | undefined> {
  if (schemaNameIsExplicit(schema) || absent.length === 0) return undefined;
  const schemaName = schema.$schemaName;
  const { inPublic } = await locateTables(dataPath.raw, schemaName, absent);
  if (inPublic.length < absent.length) return undefined;
  return `Schema public has ${absent.length === 1 ? "that table" : "those tables"}, but ${keepInPublicAdvice(schemaName)}`;
}
