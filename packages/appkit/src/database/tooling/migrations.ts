import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { writeIfChanged } from "../../type-generator/database";
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
import { refuseSymlink } from "./files";
import type { HistoryLock } from "./history-lock";

export const DRIZZLE_KIT_VERSION = "0.31.10";

interface GenerateOptions {
  readonly schema: Schema;
  readonly tag?: string;
  readonly interactive: boolean;
  readonly beforeWrite?: (migration: PlannedMigration) => void;
}

export interface SchemaObject {
  readonly kind: "table" | "column" | "default" | "constraint" | "type";
  readonly name: string;
  readonly member?: string;
}

export interface PlannedMigration {
  readonly statements: readonly string[];
  removes(object: SchemaObject): boolean;
}

export interface GeneratedMigration {
  readonly tag: string;
  readonly file: string;
  readonly statements: readonly string[];
  readonly journalBefore: string | null;
}

/**
 * drizzle-kit can't tell a rename from a drop plus a create without asking.
 * Raised in non-interactive runs instead of prompting.
 */
export class MigrationRenameAmbiguityError extends Error {
  readonly kind: "table" | "column" | "enum";
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

const BREAKPOINT = "--> statement-breakpoint\n";
/** id of drizzle-kit's empty starting snapshot, so the prevId of every first migration. */
export const ORIGIN_ID = "00000000-0000-0000-0000-000000000000";
const TAG_NAME = /^[a-z0-9_]+$/;

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
  readonly entry: string;
}

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
 * drizzle-kit reads the schema's tables through whichever drizzle-orm it
 * resolves, and declares no drizzle-orm dependency of its own.
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

function addsRequiredColumn(statement: string): boolean {
  return (
    /\bADD COLUMN\b/i.test(statement) &&
    /\bNOT NULL\b/i.test(statement) &&
    !/\b(DEFAULT|GENERATED)\b/i.test(statement)
  );
}

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

export function breakingStatements(statements: readonly string[]): string[] {
  return statementsWhere(BREAKS_PREVIOUS_RELEASE, statements);
}

export function dataDependentStatements(
  statements: readonly string[],
): string[] {
  return statementsWhere(MAY_FAIL_ON_EXISTING_ROWS, statements);
}

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

export async function hasUnmigratedChanges(
  folder: string,
  schema: Schema,
): Promise<boolean> {
  try {
    const { statements } = await diffSchema(
      snapshotAfter(folder, readJournal(folder)?.entries.at(-1)),
      schema,
      false,
    );
    return statements.length > 0;
  } catch (error) {
    if (error instanceof MigrationRenameAmbiguityError) return true;
    throw error;
  }
}

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
  await publishJournal(folder, next);
  return { tag, file, statements, journalBefore };
}

async function publishJournal(folder: string, journal: Journal): Promise<void> {
  const journalPath = journalFile(folder);
  refuseSymlink(journalPath);
  await writeIfChanged(journalPath, JSON.stringify(journal, null, 2));
}

async function unpublishJournal(
  folder: string,
  journalBefore: string | null,
): Promise<void> {
  if (journalBefore === null) {
    fs.rmSync(journalFile(folder), { force: true });
    return;
  }
  refuseSymlink(journalFile(folder));
  await writeIfChanged(journalFile(folder), journalBefore);
}

export async function discardMigrationFiles(
  lock: HistoryLock,
  migration: GeneratedMigration,
): Promise<void> {
  lock.assertHeld();
  const { folder } = lock;
  await unpublishJournal(folder, migration.journalBefore);
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
