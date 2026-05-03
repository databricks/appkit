import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  bullet,
  check,
  databasePaths,
  loadSchemaFile,
  runCommandAction,
  warn,
} from "./shared";

/**
 * `appkit db rls <entity> <spec>` — scaffold a row-level security policy.
 *
 * Generates a numbered SQL migration that enables RLS on the entity's table
 * and creates the policy, plus a TypeScript snippet that the user pastes
 * inside `defineSchema(...)` so the policy stays declared next to the table.
 *
 * Examples:
 *   appkit db rls user owner:userId
 *   appkit db rls case tenant:org_id --actions select,update
 *   appkit db rls post "status <> 'archived'" --name posts_active_only
 */
export const rlsCommand = new Command("rls")
  .description("Scaffold a row-level security policy for an entity")
  .argument("<entity>", "Logical entity key (matches a defineSchema export)")
  .argument(
    "<spec>",
    "Policy expression. Shorthand: 'owner:<column>' or 'tenant:<column>'. Anything else is treated as raw SQL.",
  )
  .option(
    "--name <name>",
    "Policy name. Defaults to '<entity>_<expression-summary>'.",
  )
  .option(
    "--actions <list>",
    "Comma-separated verbs (select,insert,update,delete,all). Defaults to 'all'.",
    "all",
  )
  .action(async (entity: string, spec: string, options: RlsCliOptions) => {
    await runCommandAction(() => runRls({ entity, spec, options }));
  });

interface RlsCliOptions {
  name?: string;
  actions?: string;
}

interface RunRlsArgs {
  entity: string;
  spec: string;
  options: RlsCliOptions;
}

interface RlsScaffoldOptions {
  schemaName?: string;
  entity: string;
  tableName: string;
  policyName: string;
  spec: string;
  actions?: ReadonlyArray<AllowedAction>;
}

interface RlsScaffold {
  migrationSql: string;
  schemaTsInsert: string;
}

interface RlsSchema {
  $schemaName?: string;
  $tables?: Record<string, { name?: string }>;
}

const ALLOWED_ACTIONS = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "all",
] as const);

type AllowedAction = "select" | "insert" | "update" | "delete" | "all";

/* ============================================================ */
/* Pure helpers                                                  */
/* ============================================================ */

/**
 * Parse a shorthand RLS expression into a SQL predicate suitable for a
 * `CREATE POLICY ... USING (<expr>)` clause.
 *
 * Supported shorthands:
 *
 * - `owner:<column>` — `<column> = current_user_id()`
 * - `tenant:<column>` — `<column> = current_tenant_id()`
 *
 * Anything else is treated as raw SQL and passed through verbatim.
 */
export function compileRlsExpression(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("RLS expression must not be empty");
  }

  const match = /^(owner|tenant):([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (!match) {
    return trimmed;
  }

  const [, kind, column] = match;
  if (kind === "owner") {
    return `${column} = current_user_id()`;
  }
  return `${column} = current_tenant_id()`;
}

/**
 * Build the migration SQL and the TypeScript snippet for a new policy.
 *
 * The migration is idempotent in development: it drops a policy of the
 * same name if it already exists, then re-creates it. The TS snippet uses
 * the schema-builder's `policy(...)` DSL with a string `using()` body.
 */
export function buildRlsScaffold(options: RlsScaffoldOptions): RlsScaffold {
  const schemaName = options.schemaName ?? "app";
  const using = compileRlsExpression(options.spec);
  const actions = options.actions ?? ["all"];
  const verb = actions.length === 1 ? actions[0] : "all";
  const qualified = `${escapeIdent(schemaName)}.${escapeIdent(options.tableName)}`;

  const migrationSql = [
    `-- RLS policy ${options.policyName} on ${qualified}`,
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${escapeIdent(options.policyName)} ON ${qualified};`,
    `CREATE POLICY ${escapeIdent(options.policyName)} ON ${qualified}`,
    `  FOR ${verb.toUpperCase()}`,
    `  USING (${using});`,
    "",
  ].join("\n");

  const tsActions = actions.map((a) => JSON.stringify(a)).join(", ");
  const schemaTsInsert = [
    `policy(${JSON.stringify(options.policyName)})`,
    `  .on(${options.entity})`,
    `  .for(${tsActions})`,
    `  .using(() => ${JSON.stringify(using)})`,
    `  .$build();`,
  ].join("\n");

  return { migrationSql, schemaTsInsert };
}

/* ============================================================ */
/* Command runner                                                */
/* ============================================================ */

async function runRls({ entity, spec, options }: RunRlsArgs): Promise<void> {
  const paths = databasePaths();
  if (!existsSync(paths.schemaFile)) {
    throw new Error(
      `${paths.schemaFile} not found. Run 'appkit db init' or 'appkit db introspect' first.`,
    );
  }

  const schema = (await loadSchemaFile(paths.schemaFile)) as RlsSchema | null;
  if (!schema) {
    throw new Error(`Could not load schema from ${paths.schemaFile}.`);
  }

  const table = schema.$tables?.[entity];
  if (!table) {
    const known = Object.keys(schema.$tables ?? {}).join(", ") || "(none)";
    throw new Error(
      `Unknown entity "${entity}" in schema. Available: ${known}`,
    );
  }

  const tableName = table.name ?? entity;
  const actions = parseActions(options.actions);
  const policyName = options.name ?? defaultPolicyName(entity, spec);

  const scaffold = buildRlsScaffold({
    schemaName: schema.$schemaName,
    entity,
    tableName,
    policyName,
    spec,
    actions,
  });

  const migrationFile = writeMigration(
    paths.migrationsDir,
    entity,
    policyName,
    scaffold.migrationSql,
  );

  console.log(check(`Wrote ${path.relative(paths.root, migrationFile)}`));
  console.log("");
  console.log(
    bullet(
      `Add this block inside defineSchema(...) in ${path.relative(
        paths.root,
        paths.schemaFile,
      )} so the policy stays declared next to the table:`,
    ),
  );
  console.log("");
  console.log(indent(scaffold.schemaTsInsert, 2));
  console.log("");
  console.log(bullet(`Apply with: appkit db migrate up`));
  console.log(
    warn(
      "Schema-side automatic injection is not yet AST-aware; the snippet above is informational only.",
    ),
  );
}

function parseActions(raw: string | undefined): AllowedAction[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const part of parts) {
    if (!ALLOWED_ACTIONS.has(part as AllowedAction)) {
      throw new Error(
        `Unknown action "${part}". Allowed: ${[...ALLOWED_ACTIONS].join(", ")}.`,
      );
    }
  }
  return parts as AllowedAction[];
}

function defaultPolicyName(entity: string, spec: string): string {
  const summary = spec
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 30);
  return `${entity}_${summary || "policy"}`;
}

function writeMigration(
  migrationsDir: string,
  entity: string,
  policyName: string,
  sql: string,
): string {
  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, { recursive: true });
  }
  const next = nextMigrationNumber(migrationsDir);
  const baseName = `${next}_rls_${entity}_${policyName}.sql`;
  const filePath = path.join(migrationsDir, baseName);
  writeFileSync(filePath, sql, "utf8");
  return filePath;
}

function nextMigrationNumber(migrationsDir: string): string {
  const files = readdirSync(migrationsDir);
  // Pick the highest 4-digit prefix that any existing file uses (sql or json).
  // We don't care about the file extension — we just want the next ordinal.
  let max = -1;
  for (const file of files) {
    const match = /^(\d{4})_/.exec(file);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(4, "0");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
