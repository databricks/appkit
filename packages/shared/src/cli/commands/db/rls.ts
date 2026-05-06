import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
 * `appkit db rls <entity> <spec>` — scaffold an RLS policy. Emits a numbered
 * `.sql` and registers it in `meta/_journal.json` so `drizzle-orm/migrator`
 * actually applies it on `appkit db migrate up`.
 */
export const rlsCommand = new Command("rls")
  .description("Scaffold a row-level security policy for an entity")
  .argument("<entity>", "Logical entity key (matches a defineSchema export)")
  .argument(
    "<spec>",
    "Policy expression. Shorthand: 'owner_email:<column>' compares to current_user_email(). Anything else is treated as raw SQL.",
  )
  .option(
    "--name <name>",
    "Policy name. Defaults to '<entity>_<expression-summary>'. Must match [A-Za-z_][A-Za-z0-9_]*.",
  )
  .option(
    "--actions <list>",
    "Comma-separated verbs (select,insert,update,delete,all). Multi-verb emits one CREATE POLICY per verb. Defaults to 'all'.",
    "all",
  )
  .option(
    "--dry-run",
    "Print intended SQL and target paths; do not write or update the journal.",
  )
  .addHelpText(
    "after",
    [
      "",
      "RLS threat model & prerequisites:",
      "  • Generated SQL emits FORCE ROW LEVEL SECURITY so the SP pool",
      "    (table owner) is also constrained — every server query through",
      "    appkit.database.<entity> is now subject to the policy.",
      "  • Identity GUC: AppKit's per-user pool sets app.user_id to the OBO",
      "    user's email on connection check-out (entity-wiring.ts). The",
      "    helper current_user_email() reads that GUC; it returns NULL on",
      "    SP connections so policies fail-closed (deny every row).",
      "  • The owner_email: shorthand expects a column that stores the user's",
      "    email (case-sensitive comparison). Map any other identifier to a",
      "    raw SQL expression instead.",
      "  • Re-run is safe: helpers + policies use CREATE OR REPLACE / DROP IF",
      "    EXISTS. But repeated runs grow the migration count — re-emit only",
      "    when the predicate genuinely changes.",
      "",
    ].join("\n"),
  )
  .action(async (entity: string, spec: string, options: RlsCliOptions) => {
    await runCommandAction(() => runRls({ entity, spec, options }));
  });

interface RlsCliOptions {
  name?: string;
  actions?: string;
  dryRun?: boolean;
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
}

interface RlsSchema {
  $schemaName?: string;
  $tables?: Record<
    string,
    { name?: string; $columns?: Record<string, unknown> }
  >;
}

const ALLOWED_ACTIONS = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "all",
] as const);

type AllowedAction = "select" | "insert" | "update" | "delete" | "all";

/** Journal format `drizzle-orm/migrator` reads. */
interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: DrizzleJournalEntry[];
}

interface DrizzleJournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const JOURNAL_VERSION = "7";
const JOURNAL_DIALECT = "postgresql";
const FORBIDDEN_RAW_SQL = /;|--|\/\*|\*\//;
const POLICY_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ============================================================ */
/* Pure helpers                                                  */
/* ============================================================ */

/**
 * Resolve `owner_email:<col>` to `<col> = <schema>.current_user_email()`.
 * Anything else is raw SQL, gated by `validateRawSqlPredicate`.
 */
export function compileRlsExpression(
  spec: string,
  options: { schemaName?: string } = {},
): { sql: string; shorthandColumn: string | null } {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("RLS expression must not be empty");

  const schema = escapeIdent(options.schemaName ?? "app");
  const match = /^owner_email:([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (match) {
    const [, column] = match;
    return {
      sql: `${column} = ${schema}.current_user_email()`,
      shorthandColumn: column,
    };
  }

  if (/^(owner|tenant):/.test(trimmed)) {
    throw new Error(
      "owner: / tenant: shorthands were removed. Use owner_email:<column> " +
        "(compares to current_user_email()) or write raw SQL. The runtime " +
        "currently only sets app.user_id (= identity email).",
    );
  }

  validateRawSqlPredicate(trimmed);
  return { sql: trimmed, shorthandColumn: null };
}

/**
 * Build migration SQL: ENABLE+FORCE RLS once, then one DROP/CREATE POLICY
 * block per action. Multi-verb specs get one policy per verb, suffixed.
 */
export function buildRlsScaffold(options: RlsScaffoldOptions): RlsScaffold {
  validatePolicyName(options.policyName);
  const schemaName = options.schemaName ?? "app";
  const compiled = compileRlsExpression(options.spec, { schemaName });
  const actions = options.actions ?? ["all"];
  const qualified = `${escapeIdent(schemaName)}.${escapeIdent(options.tableName)}`;

  const blocks: string[] = [
    `-- RLS policy ${options.policyName} on ${qualified}`,
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;`,
  ];

  const isMultiVerb = actions.length > 1;
  for (const action of actions) {
    const policyName = isMultiVerb
      ? `${options.policyName}_${action}`
      : options.policyName;
    validatePolicyName(policyName);
    blocks.push(
      `DROP POLICY IF EXISTS ${escapeIdent(policyName)} ON ${qualified};`,
      renderCreatePolicy(qualified, policyName, action, compiled.sql),
    );
  }
  blocks.push("");

  return { migrationSql: blocks.join("\n") };
}

/**
 * Helpers SQL. `current_user_email()` reads the `app.user_id` GUC set by
 * the per-user pool; schema-qualified so `search_path` can't rebind it.
 */
export function buildHelpersMigrationSql(schemaName: string): string {
  const schema = escapeIdent(schemaName);
  return [
    "-- AppKit RLS helpers — see entity-wiring.ts for the GUC contract.",
    `CREATE OR REPLACE FUNCTION ${schema}.current_user_email() RETURNS text`,
    "  LANGUAGE sql STABLE AS",
    "  $$ SELECT current_setting('app.user_id', true) $$;",
    "",
  ].join("\n");
}

function renderCreatePolicy(
  qualified: string,
  policyName: string,
  action: AllowedAction,
  predicate: string,
): string {
  const head = `CREATE POLICY ${escapeIdent(policyName)} ON ${qualified}\n  FOR ${action.toUpperCase()}`;
  switch (action) {
    case "select":
    case "delete":
      return `${head}\n  USING (${predicate});`;
    case "insert":
      return `${head}\n  WITH CHECK (${predicate});`;
    default:
      return `${head}\n  USING (${predicate})\n  WITH CHECK (${predicate});`;
  }
}

function validateRawSqlPredicate(expr: string): void {
  if (FORBIDDEN_RAW_SQL.test(expr)) {
    throw new Error(
      `Raw RLS predicate must not contain ';', SQL comments ('--', '/*', '*/'). Got: ${expr}`,
    );
  }
  let depth = 0;
  for (const ch of expr) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) {
        throw new Error(`Unbalanced ')' in RLS predicate: ${expr}`);
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced parens in RLS predicate: ${expr}`);
  }
}

function validatePolicyName(name: string): void {
  if (!POLICY_NAME_REGEX.test(name)) {
    throw new Error(
      `Policy name must match ${POLICY_NAME_REGEX.source} (got '${name}'). ` +
        "Used both as a SQL identifier and migration filename — strict for safety.",
    );
  }
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
  const schemaName = schema.$schemaName ?? "app";
  const actions = parseActions(options.actions);
  const policyName =
    options.name ?? defaultPolicyName(entity, spec, options.name === undefined);
  validatePolicyName(policyName);

  const compiled = compileRlsExpression(spec, { schemaName });
  if (compiled.shorthandColumn) {
    assertColumnExists(table, entity, compiled.shorthandColumn);
  } else {
    console.log(warn(`Using raw SQL predicate: ${compiled.sql}`));
  }

  const scaffold = buildRlsScaffold({
    schemaName,
    entity,
    tableName,
    policyName,
    spec,
    actions,
  });

  if (options.dryRun) {
    runDryRun(paths, schemaName, scaffold.migrationSql);
    return;
  }

  const helpersFile = ensureRlsHelpersMigration(
    paths.migrationsDir,
    schemaName,
  );
  if (helpersFile) {
    console.log(check(`Wrote ${path.relative(paths.root, helpersFile)}`));
  }

  const migrationFile = writeMigration(
    paths.migrationsDir,
    entity,
    policyName,
    scaffold.migrationSql,
  );
  console.log(check(`Wrote ${path.relative(paths.root, migrationFile)}`));
  console.log("");
  console.log(bullet(`Apply with: appkit db migrate up`));
  console.log(
    bullet(
      "Track the policy in the migration file above. The schema-side `policy()` DSL is not yet implemented.",
    ),
  );
}

function runDryRun(
  paths: ReturnType<typeof databasePaths>,
  schemaName: string,
  migrationSql: string,
): void {
  console.log(bullet(`Dry run: would write into ${paths.migrationsDir}`));
  console.log(bullet(`Helpers (schema-qualified to "${schemaName}"):`));
  console.log("");
  console.log(indent(buildHelpersMigrationSql(schemaName), 2));
  console.log(bullet("Policy migration:"));
  console.log("");
  console.log(indent(migrationSql, 2));
  console.log(bullet("No journal entries were written."));
}

function assertColumnExists(
  table: { $columns?: Record<string, unknown> },
  entity: string,
  column: string,
): void {
  const columns = table.$columns ?? {};
  if (!Object.hasOwn(columns, column)) {
    const known = Object.keys(columns).join(", ") || "(none)";
    throw new Error(
      `Column "${column}" not found on entity "${entity}". Available: ${known}`,
    );
  }
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
  if (parts.includes("all") && parts.length > 1) {
    throw new Error("'all' cannot be combined with other actions.");
  }
  return parts as AllowedAction[];
}

/** Slug the spec; append a hash on truncation to avoid 30-char collisions. */
function defaultPolicyName(
  entity: string,
  spec: string,
  appendHash: boolean,
): string {
  const slug = spec
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const truncated = slug.slice(0, 30);
  if (appendHash && truncated !== slug) {
    const suffix = createHash("sha1").update(spec).digest("hex").slice(0, 6);
    return `${entity}_${truncated || "policy"}_${suffix}`;
  }
  return `${entity}_${truncated || "policy"}`;
}

/* ============================================================ */
/* Filesystem + journal                                          */
/* ============================================================ */

export function writeMigration(
  migrationsDir: string,
  entity: string,
  policyName: string,
  sql: string,
): string {
  ensureDir(migrationsDir);
  const tag = `${nextMigrationNumber(migrationsDir)}_rls_${entity}_${policyName}`;
  assertSafeFilename(tag);
  const filePath = path.join(migrationsDir, `${tag}.sql`);
  writeFileSync(filePath, sql, "utf8");
  appendJournalEntry(migrationsDir, tag);
  return filePath;
}

export function ensureRlsHelpersMigration(
  migrationsDir: string,
  schemaName: string,
): string | null {
  ensureDir(migrationsDir);
  const journal = readJournal(migrationsDir);
  if (journal.entries.some((e) => /_appkit_rls_helpers$/.test(e.tag))) {
    return null;
  }
  const tag = `${nextMigrationNumber(migrationsDir)}_appkit_rls_helpers`;
  assertSafeFilename(tag);
  const filePath = path.join(migrationsDir, `${tag}.sql`);
  writeFileSync(filePath, buildHelpersMigrationSql(schemaName), "utf8");
  appendJournalEntry(migrationsDir, tag);
  return filePath;
}

/** Append to `meta/_journal.json` — `drizzle-orm/migrator` skips anything not listed. */
function appendJournalEntry(migrationsDir: string, tag: string): void {
  const journalPath = journalFilePath(migrationsDir);
  const journal = readJournal(migrationsDir);
  if (journal.entries.some((entry) => entry.tag === tag)) return;
  const idx = journal.entries.length;
  journal.entries.push({
    idx,
    version: JOURNAL_VERSION,
    when: Date.now(),
    tag,
    breakpoints: false,
  });
  ensureDir(path.dirname(journalPath));
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

function readJournal(migrationsDir: string): DrizzleJournal {
  const journalPath = journalFilePath(migrationsDir);
  if (!existsSync(journalPath)) {
    return { version: JOURNAL_VERSION, dialect: JOURNAL_DIALECT, entries: [] };
  }
  const raw = readFileSync(journalPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<DrizzleJournal>;
  return {
    version: parsed.version ?? JOURNAL_VERSION,
    dialect: parsed.dialect ?? JOURNAL_DIALECT,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
}

function journalFilePath(migrationsDir: string): string {
  return path.join(migrationsDir, "meta", "_journal.json");
}

/** Max of journal + on-disk so we outrun orphans from prior bad runs. */
function nextMigrationNumber(migrationsDir: string): string {
  let max = -1;
  const journal = readJournal(migrationsDir);
  for (const entry of journal.entries) {
    const match = /^(\d{4})_/.exec(entry.tag);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (existsSync(migrationsDir)) {
    for (const file of readDirSafe(migrationsDir)) {
      const match = /^(\d{4})_/.exec(file);
      if (!match) continue;
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return String(max + 1).padStart(4, "0");
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function assertSafeFilename(tag: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(tag)) {
    throw new Error(
      `Refusing to write migration tag '${tag}' — only [A-Za-z0-9_] allowed.`,
    );
  }
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
