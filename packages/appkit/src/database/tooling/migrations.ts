import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  type Journal,
  type JournalEntry,
  journalFile,
  metaFolder,
  migrationFile,
  migrationPrefix,
  readJournal,
  readJsonFile,
  snapshotFile,
} from "../migrations/paths";
import type { Schema } from "../schema-builder";
import { drizzleKitImports } from "./drizzle-exports";
import { writeFileAtomic } from "./files";
import type { HistoryLock } from "./history-lock";

/**
 * The drizzle-kit release the snapshots and SQL are written for; the optional
 * peer dependency in package.json pins the same version.
 */
export const DRIZZLE_KIT_VERSION = "0.31.10";

interface GenerateOptions {
  readonly schema: Schema;
  /** Default "migration" → "NNNN_migration". */
  readonly tag?: string;
  /** false: an ambiguous rename throws instead of prompting. */
  readonly interactive: boolean;
  /** Sees the migration before anything is written; throwing writes nothing. */
  readonly beforeWrite?: (migration: PlannedMigration) => void;
}

/** An object of the app schema, by raw catalog name. */
export interface SchemaObject {
  readonly kind: "table" | "column" | "default" | "constraint" | "type";
  /** The table, or the enum type for "type". */
  readonly name: string;
  /** The column for "column" and "default", the constraint for "constraint". */
  readonly member?: string;
}

/** A migration generateMigrationFiles is about to write. */
export interface PlannedMigration {
  readonly statements: readonly string[];
  /** Whether it removes the object: the latest snapshot has it and the new one does not. */
  removes(object: SchemaObject): boolean;
}

export interface GeneratedMigration {
  /** e.g. "0001_migration". */
  readonly tag: string;
  /** Absolute path of the written .sql file. */
  readonly file: string;
  readonly statements: readonly string[];
  /** The journal's text this migration replaced; null when there was none. */
  readonly journalBefore: string | null;
}

/**
 * drizzle-kit can't tell a rename from a drop plus a create without asking.
 * Raised in non-interactive runs instead of prompting.
 */
export class MigrationRenameAmbiguityError extends Error {
  readonly kind: "table" | "column" | "enum";
  /** The table whose columns changed, or the schema for table and enum changes. */
  readonly table: string;
  readonly created: readonly string[];
  readonly deleted: readonly string[];

  constructor(
    kind: MigrationRenameAmbiguityError["kind"],
    table: string,
    created: readonly string[],
    deleted: readonly string[],
  ) {
    const scope =
      kind === "column" ? `columns of table "${table}"` : `${kind}s`;
    super(
      `Cannot tell whether ${scope} were renamed: removed ${deleted.join(", ")}; added ${created.join(", ")}. ` +
        "Run the command in an interactive terminal to choose between a rename and a drop plus create.",
    );
    this.name = "MigrationRenameAmbiguityError";
    this.kind = kind;
    this.table = table;
    this.created = Object.freeze([...created]);
    this.deleted = Object.freeze([...deleted]);
  }
}

/** drizzle-kit's statement separator in v7 migration files. */
const BREAKPOINT = "--> statement-breakpoint\n";
const ORIGIN_ID = "00000000-0000-0000-0000-000000000000";
const TAG_NAME = /^[a-z0-9_]+$/;

/** The parts of a drizzle-kit PostgreSQL snapshot this module reads. */
interface Snapshot {
  id: string;
  /** Keyed "<schema>.<table>", public included. */
  tables: Record<string, SnapshotTable>;
  /** Keyed "<schema>.<type>", public included. */
  enums: Record<string, unknown>;
  [key: string]: unknown;
}

interface SnapshotTable {
  columns: Record<string, { default?: unknown }>;
  foreignKeys?: Record<string, unknown>;
  uniqueConstraints?: Record<string, unknown>;
  checkConstraints?: Record<string, unknown>;
  compositePrimaryKeys?: Record<string, unknown>;
}

function snapshotHas(
  snapshot: Snapshot,
  schemaName: string,
  object: SchemaObject,
): boolean {
  const key = `${schemaName}.${object.name}`;
  if (object.kind === "type") return Object.hasOwn(snapshot.enums, key);
  const table = Object.hasOwn(snapshot.tables, key)
    ? snapshot.tables[key]
    : undefined;
  if (!table) return false;
  const member = object.member ?? "";
  const column = Object.hasOwn(table.columns, member)
    ? table.columns[member]
    : undefined;
  switch (object.kind) {
    case "table":
      return true;
    case "column":
      return column !== undefined;
    case "default":
      return column?.default !== undefined;
    case "constraint":
      return [
        table.foreignKeys,
        table.uniqueConstraints,
        table.checkConstraints,
        table.compositePrimaryKeys,
      ].some(
        (constraints) => !!constraints && Object.hasOwn(constraints, member),
      );
  }
}

/** drizzle-kit's empty starting snapshot (its `dryPg`). */
function originSnapshot(): Snapshot {
  return {
    id: ORIGIN_ID,
    prevId: "",
    version: "7",
    dialect: "postgresql",
    tables: {},
    enums: {},
    schemas: {},
    sequences: {},
    roles: {},
    policies: {},
    views: {},
    _meta: { schemas: {}, tables: {}, columns: {} },
  };
}

/** The snapshot after `entry`; the origin before the first migration. */
function snapshotAfter(
  folder: string,
  entry: JournalEntry | undefined,
): Snapshot {
  if (!entry) return originSnapshot();
  const file = snapshotFile(folder, entry.idx);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing ${file} for migration ${entry.tag}. Restore it from version control; it is the baseline for the next migration.`,
    );
  }
  return readJsonFile<Snapshot>(file);
}

function keyDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { created: string[]; deleted: string[] } {
  return {
    created: Object.keys(after).filter((key) => !Object.hasOwn(before, key)),
    deleted: Object.keys(before).filter((key) => !Object.hasOwn(after, key)),
  };
}

/** The same "created and deleted together" conditions that make drizzle-kit prompt. */
function findRenameAmbiguity(
  prev: Snapshot,
  cur: Snapshot,
  schemaName: string,
): MigrationRenameAmbiguityError | null {
  const tables = keyDiff(prev.tables, cur.tables);
  if (tables.created.length > 0 && tables.deleted.length > 0) {
    return new MigrationRenameAmbiguityError(
      "table",
      schemaName,
      tables.created,
      tables.deleted,
    );
  }
  const enums = keyDiff(prev.enums, cur.enums);
  if (enums.created.length > 0 && enums.deleted.length > 0) {
    return new MigrationRenameAmbiguityError(
      "enum",
      schemaName,
      enums.created,
      enums.deleted,
    );
  }
  for (const [key, table] of Object.entries(cur.tables)) {
    const before = prev.tables[key];
    if (!before) continue;
    const columns = keyDiff(before.columns, table.columns);
    if (columns.created.length > 0 && columns.deleted.length > 0) {
      return new MigrationRenameAmbiguityError(
        "column",
        key,
        columns.created,
        columns.deleted,
      );
    }
  }
  return null;
}

/**
 * Whether drizzle-kit itself is not installed, or is a release without the
 * `./api` export; module loaders may wrap that error.
 */
function isDrizzleKitMissing(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (
      (code === "ERR_MODULE_NOT_FOUND" &&
        /['"]drizzle-kit['"]/.test(current.message)) ||
      (code === "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
        current.message.includes("drizzle-kit"))
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

interface InstalledPackage {
  readonly version: string;
  /** The resolved entry file, to resolve that package's own imports from. */
  readonly entry: string;
}

/** The package `name` resolves to from `from`; null when it does not resolve. */
function installedPackage(name: string, from: string): InstalledPackage | null {
  let entry: string;
  try {
    entry = createRequire(from).resolve(name);
  } catch {
    return null;
  }
  // Neither drizzle-kit nor drizzle-orm exports ./package.json.
  for (
    let dir = path.dirname(entry);
    dir !== path.dirname(dir);
    dir = path.dirname(dir)
  ) {
    const file = path.join(dir, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = readJsonFile<{ name?: unknown; version?: unknown }>(file);
    if (pkg.name === name && typeof pkg.version === "string") {
      return { version: pkg.version, entry };
    }
  }
  return null;
}

/**
 * The version of the drizzle-kit the app at `root` has; null when it has none.
 * The node_modules walk is what ESM resolution does; createRequire would also
 * follow NODE_PATH, which `import("drizzle-kit/api")` ignores.
 */
export function drizzleKitVersionAt(root: string): string | null {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "node_modules/drizzle-kit/package.json");
    if (fs.existsSync(file)) {
      const { version } = readJsonFile<{ version?: unknown }>(file);
      return typeof version === "string" ? version : null;
    }
    if (dir === path.dirname(dir)) return null;
  }
}

/**
 * Why the drizzle-kit that resolves from `from` must not write migrations;
 * undefined when it may, or when it is not installed at all. drizzle-kit reads
 * the schema's tables through whichever drizzle-orm it resolves, and declares
 * no drizzle-orm dependency of its own.
 */
export function drizzleKitMismatch(
  from: string = import.meta.url,
): string | undefined {
  const kit = installedPackage("drizzle-kit", from);
  if (!kit) return undefined;
  if (kit.version !== DRIZZLE_KIT_VERSION) {
    return `AppKit writes migrations with drizzle-kit ${DRIZZLE_KIT_VERSION}, but ${kit.version} is installed. Install that version: npm install --save-dev drizzle-kit@${DRIZZLE_KIT_VERSION}`;
  }
  const orm = installedPackage("drizzle-orm", import.meta.url);
  const kitOrm = installedPackage("drizzle-orm", kit.entry);
  if (orm && kitOrm && kitOrm.version !== orm.version) {
    return `drizzle-kit loads drizzle-orm ${kitOrm.version}, but AppKit builds schemas with ${orm.version}. Use the same version: npm install drizzle-orm@${orm.version}`;
  }
  return undefined;
}

/**
 * drizzle-kit is large, so apps install it as a dev dependency and it is loaded
 * only when a migration is generated.
 */
async function loadDrizzleKit(): Promise<typeof import("drizzle-kit/api")> {
  const mismatch = drizzleKitMismatch();
  if (mismatch) throw new Error(mismatch);
  try {
    return await import("drizzle-kit/api");
  } catch (error) {
    if (!isDrizzleKitMissing(error)) throw error;
    throw new Error(
      `Generating migrations needs drizzle-kit, which is not installed. Add it as a dev dependency: npm install --save-dev drizzle-kit@${DRIZZLE_KIT_VERSION}`,
      { cause: error },
    );
  }
}

type StatementPredicate = (statement: string) => boolean;

const matches =
  (pattern: RegExp): StatementPredicate =>
  (statement) =>
    pattern.test(statement);

/** A new column nothing fills: old instances insert without it, and existing rows have no value for it. */
function addsRequiredColumn(statement: string): boolean {
  return (
    /\bADD COLUMN\b/i.test(statement) &&
    /\bNOT NULL\b/i.test(statement) &&
    !/\b(DEFAULT|GENERATED)\b/i.test(statement)
  );
}

/** A constraint declared on the new column itself. An identity fills every row with a distinct value, so its key holds. */
function addsConstrainedColumn(statement: string): boolean {
  return (
    /\bADD COLUMN\b/i.test(statement) &&
    /\b(UNIQUE|PRIMARY KEY|CHECK|REFERENCES)\b/i.test(statement) &&
    !/\bAS IDENTITY\b/i.test(statement)
  );
}

const BREAKS_PREVIOUS_RELEASE: readonly StatementPredicate[] = [
  matches(/^DROP (TABLE|VIEW|MATERIALIZED VIEW|TYPE|SEQUENCE|SCHEMA)\b/i),
  matches(/\bDROP COLUMN\b/i),
  matches(/\bRENAME\b/i),
  matches(/\bSET DATA TYPE\b/i),
  matches(/\bSET NOT NULL\b/i),
  addsRequiredColumn,
];

const MAY_FAIL_ON_EXISTING_ROWS: readonly StatementPredicate[] = [
  matches(/\bSET NOT NULL\b/i),
  matches(/\bSET DATA TYPE\b/i),
  addsRequiredColumn,
  matches(/\bADD CONSTRAINT\b/i),
  matches(/\bADD PRIMARY KEY\b/i),
  addsConstrainedColumn,
  matches(/^CREATE UNIQUE INDEX\b/i),
];

function statementsWhere(
  predicates: readonly StatementPredicate[],
  statements: readonly string[],
): string[] {
  return statements.filter((statement) =>
    predicates.some((applies) => applies(statement.trimStart())),
  );
}

/**
 * Statements that break instances still running the previous release. Apps
 * keeps them serving while the new instance migrates on start, and a code
 * rollback cannot undo a migration.
 */
export function breakingStatements(statements: readonly string[]): string[] {
  return statementsWhere(BREAKS_PREVIOUS_RELEASE, statements);
}

export function dataDependentStatements(
  statements: readonly string[],
): string[] {
  return statementsWhere(MAY_FAIL_ON_EXISTING_ROWS, statements);
}

/** drizzle-kit's diff from `prev` to the schema: the new snapshot and its SQL. */
async function diffSchema(
  prev: Snapshot,
  schema: Schema,
  interactive: boolean,
): Promise<{ cur: Snapshot; statements: string[] }> {
  const { generateDrizzleJson, generateMigration } = await loadDrizzleKit();
  const cur = generateDrizzleJson(drizzleKitImports(schema), prev.id, [
    schema.$schemaName,
  ]) as unknown as Snapshot;

  if (!interactive) {
    const ambiguity = findRenameAmbiguity(prev, cur, schema.$schemaName);
    if (ambiguity) throw ambiguity;
  }

  type KitSnapshot = Parameters<typeof generateMigration>[0];
  const statements = await generateMigration(
    prev as unknown as KitSnapshot,
    cur as unknown as KitSnapshot,
  );
  return { cur, statements };
}

/**
 * Whether the files of `tags`, the newest committed migrations, hold the SQL
 * generation writes for the schema on top of the migrations before them.
 */
export async function generatesPending(
  folder: string,
  schema: Schema,
  tags: readonly string[],
  interactive: boolean,
): Promise<boolean> {
  const entries = readJournal(folder)?.entries ?? [];
  const first = entries.findIndex((entry) => entry.tag === tags[0]);
  if (first < 0) return false;
  const { statements } = await diffSchema(
    snapshotAfter(folder, entries[first - 1]),
    schema,
    interactive,
  );
  const normalized = (text: string) => text.replace(/\r\n/g, "\n");
  const committed = tags.flatMap((tag) =>
    normalized(fs.readFileSync(migrationFile(folder, tag), "utf-8")).split(
      BREAKPOINT,
    ),
  );
  return (
    committed.length === statements.length &&
    committed.every(
      (statement, index) =>
        statement.trim() === normalized(statements[index] ?? "").trim(),
    )
  );
}

/**
 * Diff the schema against the latest committed snapshot with drizzle-kit and
 * write the next v7 migration: `NNNN_<tag>.sql`, `meta/NNNN_snapshot.json`,
 * and the appended `meta/_journal.json`. null when nothing changed.
 */
export async function generateMigrationFiles(
  lock: HistoryLock,
  options: GenerateOptions,
): Promise<GeneratedMigration | null> {
  const name = options.tag ?? "migration";
  if (!TAG_NAME.test(name)) {
    throw new Error(
      `Migration tag "${name}" must use lowercase letters, digits and underscores`,
    );
  }
  const { folder } = lock;

  const journal = readJournal(folder);
  const prev = snapshotAfter(folder, journal?.entries.at(-1));
  const { cur, statements } = await diffSchema(
    prev,
    options.schema,
    options.interactive,
  );
  if (statements.length === 0) return null;
  const schemaName = options.schema.$schemaName;
  options.beforeWrite?.({
    statements,
    removes: (object) =>
      snapshotHas(prev, schemaName, object) &&
      !snapshotHas(cur, schemaName, object),
  });

  const entries = journal?.entries ?? [];
  const last = entries.at(-1);
  const idx = last ? last.idx + 1 : 0;
  const tag = `${migrationPrefix(idx)}_${name}`;
  const entry: JournalEntry = {
    idx,
    version: "7",
    // The migrator applies entries newer than the last recorded one, so `when` must increase.
    when: Math.max(Date.now(), (last?.when ?? 0) + 1),
    tag,
    breakpoints: true,
  };
  const next: Journal = {
    version: "7",
    dialect: "postgresql",
    entries: [...entries, entry],
  };

  lock.assertHeld();
  const file = migrationFile(folder, tag);
  const journalPath = journalFile(folder);
  const journalBefore = fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, "utf-8")
    : null;
  fs.mkdirSync(metaFolder(folder), { recursive: true });
  fs.writeFileSync(
    snapshotFile(folder, idx),
    JSON.stringify(
      { ...cur, _meta: { columns: {}, schemas: {}, tables: {} } },
      null,
      2,
    ),
  );
  fs.writeFileSync(file, statements.join(BREAKPOINT));
  // The journal is written last: it is what makes the migration visible.
  writeFileAtomic(journalPath, JSON.stringify(next, null, 2));
  return { tag, file, statements, journalBefore };
}

/**
 * Remove a migration generateMigrationFiles wrote under the same lock and put
 * back the journal it replaced (none: the folders it created go too).
 */
export function discardMigrationFiles(
  lock: HistoryLock,
  migration: GeneratedMigration,
): void {
  lock.assertHeld();
  const { folder } = lock;
  // The journal goes back first, as it is what names the migration: a crash
  // after this point leaves files no journal names, never the reverse.
  if (migration.journalBefore === null) {
    fs.rmSync(journalFile(folder), { force: true });
  } else {
    writeFileAtomic(journalFile(folder), migration.journalBefore);
  }
  fs.rmSync(migration.file, { force: true });
  fs.rmSync(snapshotFile(folder, Number.parseInt(migration.tag, 10)), {
    force: true,
  });
  if (migration.journalBefore !== null) return;
  for (const dir of [metaFolder(folder), folder]) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0)
      fs.rmdirSync(dir);
  }
}
