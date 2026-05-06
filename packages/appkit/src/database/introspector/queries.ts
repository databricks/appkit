import type { Pool } from "pg";
import type {
  CascadeAction,
  IntrospectedColumn,
  IntrospectedPolicy,
  IntrospectedTable,
} from "./types";

/**
 * Introspect a database into one deterministic `IntrospectedTable[]`. Catalog
 * data is queried in focused passes and merged into table shells, keeping
 * each SQL query small.
 */
export async function runIntrospection(
  pool: Pool,
  schemas: string[],
  exclude: ReadonlySet<string>,
): Promise<IntrospectedTable[]> {
  // Tables must come first since columns/policies attach to them; the four
  // remaining catalog passes are independent so we fan them out in parallel.
  const tables = await fetchTables(pool, schemas, exclude);
  const tableMap = new Map(tables.map((t) => [`${t.schema}.${t.name}`, t]));

  const [columns, foreignKeys, primaryKeys, policies] = await Promise.all([
    fetchColumns(pool, schemas),
    fetchForeignKeys(pool, schemas),
    fetchPrimaryKeys(pool, schemas),
    fetchPolicies(pool, schemas),
  ]);

  for (const col of columns) {
    const table = tableMap.get(`${col.schema}.${col.table}`);
    if (table) table.columns.push(col.column);
  }

  for (const fk of foreignKeys) {
    const table = tableMap.get(`${fk.schema}.${fk.table}`);
    const column = table?.columns.find((c) => c.name === fk.column);
    if (column) column.references = fk.target;
  }

  for (const pk of primaryKeys) {
    const table = tableMap.get(`${pk.schema}.${pk.table}`);
    const column = table?.columns.find((c) => c.name === pk.column);
    if (column) column.isPrimaryKey = true;
  }

  for (const policy of policies) {
    const table = tableMap.get(`${policy.schema}.${policy.table}`);
    if (table) table.policies.push(policy.policy);
  }

  return tables;
}

async function fetchTables(
  pool: Pool,
  schemas: string[],
  exclude: ReadonlySet<string>,
): Promise<IntrospectedTable[]> {
  const { rows } = await pool.query<{ schema: string; name: string }>(
    `
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname = ANY($1::text[])
      ORDER BY n.nspname, c.relname
    `,
    [schemas],
  );

  return rows
    .filter((row) => !exclude.has(row.name))
    .map((row) => ({
      schema: row.schema,
      name: row.name,
      columns: [],
      policies: [],
    }));
}

async function fetchColumns(
  pool: Pool,
  schemas: string[],
): Promise<
  Array<{ schema: string; table: string; column: IntrospectedColumn }>
> {
  const { rows } = await pool.query<{
    schema: string;
    table: string;
    name: string;
    pg_type: string;
    nullable: boolean;
    has_default: boolean;
    default_expression: string | null;
    server_generated: boolean;
  }>(
    `
      SELECT
        table_schema AS schema,
        table_name AS table,
        column_name AS name,
        udt_name AS pg_type,
        is_nullable = 'YES' AS nullable,
        column_default IS NOT NULL AS has_default,
        column_default AS default_expression,
        (is_identity = 'YES' OR column_default LIKE 'nextval(%') AS server_generated
      FROM information_schema.columns
      WHERE table_schema = ANY($1::text[])
      ORDER BY table_schema, table_name, ordinal_position
    `,
    [schemas],
  );

  return rows.map((row) => ({
    schema: row.schema,
    table: row.table,
    column: {
      name: row.name,
      pgType: row.pg_type,
      nullable: row.nullable,
      hasDefault: row.has_default,
      defaultExpression: row.default_expression ?? undefined,
      serverGenerated: row.server_generated || undefined,
    },
  }));
}

// Constraint names aren't globally unique, so every catalog join carries the
// constraint schema. Without it, two schemas can cross-wire FK targets.
async function fetchForeignKeys(pool: Pool, schemas: string[]) {
  const { rows } = await pool.query<{
    schema: string;
    table: string;
    column: string;
    target_schema: string;
    target_table: string;
    target_column: string;
    on_delete: string;
    on_update: string;
  }>(
    `
      SELECT
        tc.table_schema AS schema,
        tc.table_name AS table,
        kcu.column_name AS column,
        ccu.table_schema AS target_schema,
        ccu.table_name AS target_table,
        ccu.column_name AS target_column,
        rc.delete_rule AS on_delete,
        rc.update_rule AS on_update
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.constraint_schema = tc.constraint_schema
       AND kcu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.constraint_schema = rc.unique_constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = ANY($1::text[])
    `,
    [schemas],
  );

  return rows.map((row) => ({
    schema: row.schema,
    table: row.table,
    column: row.column,
    target: {
      schema: row.target_schema,
      table: row.target_table,
      column: row.target_column,
      onDelete: cascadeAction(row.on_delete),
      onUpdate: cascadeAction(row.on_update),
    },
  }));
}

async function fetchPrimaryKeys(pool: Pool, schemas: string[]) {
  const { rows } = await pool.query<{
    schema: string;
    table: string;
    column: string;
  }>(
    `
      SELECT
        tc.table_schema AS schema,
        tc.table_name AS table,
        kcu.column_name AS column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.constraint_schema = tc.constraint_schema
       AND kcu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = ANY($1::text[])
    `,
    [schemas],
  );

  return rows;
}

async function fetchPolicies(
  pool: Pool,
  schemas: string[],
): Promise<
  Array<{ schema: string; table: string; policy: IntrospectedPolicy }>
> {
  const { rows } = await pool.query<{
    schema: string;
    table: string;
    name: string;
    permissive: boolean;
    for_cmd: string;
    roles: string[];
    using_expr: string | null;
    check_expr: string | null;
  }>(
    `
      SELECT
        schemaname AS schema,
        tablename AS table,
        policyname AS name,
        permissive = 'PERMISSIVE' AS permissive,
        cmd AS for_cmd,
        roles,
        qual AS using_expr,
        with_check AS check_expr
      FROM pg_policies
      WHERE schemaname = ANY($1::text[])
    `,
    [schemas],
  );

  return rows.map((row) => ({
    schema: row.schema,
    table: row.table,
    policy: {
      name: row.name,
      permissive: row.permissive,
      for:
        row.for_cmd === "ALL"
          ? ["select", "insert", "update", "delete"]
          : [row.for_cmd.toLowerCase() as IntrospectedPolicy["for"][number]],
      roles: row.roles,
      using: row.using_expr ?? undefined,
      withCheck: row.check_expr ?? undefined,
    },
  }));
}

function cascadeAction(value: string): CascadeAction {
  switch (value) {
    case "CASCADE":
      return "cascade";
    case "SET NULL":
      return "set null";
    case "RESTRICT":
      return "restrict";
    default:
      return "no action";
  }
}
