import { randomUUID } from "node:crypto";
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

/**
 * The drizzle-kit release the snapshots and SQL are written for; the optional
 * peer dependency in package.json pins the same version.
 */
export const DRIZZLE_KIT_VERSION = "0.31.10";

interface GenerateOptions {
  /** Absolute migrations folder. */
  readonly folder: string;
  readonly schema: Schema;
  /** false: an ambiguous rename throws instead of prompting. */
  readonly interactive: boolean;
}

export interface GeneratedMigration {
  /** e.g. "0001_migration". */
  readonly tag: string;
  /** Absolute path of the written .sql file. */
  readonly file: string;
  readonly statements: readonly string[];
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
        "Run `appkit db migrate` in an interactive terminal to choose between a rename and a drop plus create.",
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

/** The parts of a drizzle-kit PostgreSQL snapshot this module reads. */
interface Snapshot {
  id: string;
  tables: Record<string, { columns: Record<string, unknown> }>;
  enums: Record<string, unknown>;
  [key: string]: unknown;
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

function latestSnapshot(folder: string, journal: Journal | null): Snapshot {
  const last = journal?.entries.at(-1);
  if (!last) return originSnapshot();
  const file = snapshotFile(folder, last.idx);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing ${file} for migration ${last.tag}. Restore it from version control; it is the baseline for the next migration.`,
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

/** Replace a file through a rename, so a crash never leaves it half written. */
function writeFileAtomic(file: string, content: string): void {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Diff the schema against the latest committed snapshot with drizzle-kit and
 * write the next v7 migration: `NNNN_migration.sql`, `meta/NNNN_snapshot.json`,
 * and the appended `meta/_journal.json`. null when nothing changed.
 */
export async function generateMigrationFiles(
  options: GenerateOptions,
): Promise<GeneratedMigration | null> {
  const { generateDrizzleJson, generateMigration } = await loadDrizzleKit();

  const journal = readJournal(options.folder);
  const prev = latestSnapshot(options.folder, journal);
  const cur = generateDrizzleJson(drizzleKitImports(options.schema), prev.id, [
    options.schema.$schemaName,
  ]) as unknown as Snapshot;

  if (!options.interactive) {
    const ambiguity = findRenameAmbiguity(
      prev,
      cur,
      options.schema.$schemaName,
    );
    if (ambiguity) throw ambiguity;
  }

  type KitSnapshot = Parameters<typeof generateMigration>[0];
  const statements = await generateMigration(
    prev as unknown as KitSnapshot,
    cur as unknown as KitSnapshot,
  );
  if (statements.length === 0) return null;

  const entries = journal?.entries ?? [];
  const last = entries.at(-1);
  const idx = last ? last.idx + 1 : 0;
  const tag = `${migrationPrefix(idx)}_migration`;
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

  const file = migrationFile(options.folder, tag);
  fs.mkdirSync(metaFolder(options.folder), { recursive: true });
  fs.writeFileSync(
    snapshotFile(options.folder, idx),
    JSON.stringify(
      { ...cur, _meta: { columns: {}, schemas: {}, tables: {} } },
      null,
      2,
    ),
  );
  fs.writeFileSync(file, statements.join(BREAKPOINT));
  // The journal is written last: it is what makes the migration visible.
  writeFileAtomic(journalFile(options.folder), JSON.stringify(next, null, 2));
  return { tag, file, statements };
}

/**
 * Remove a migration generateMigrationFiles wrote and put back the journal it
 * replaced (null: there was none, so the folders it created go too).
 */
export function discardMigrationFiles(
  folder: string,
  migration: GeneratedMigration,
  journalBefore: string | null,
): void {
  fs.rmSync(migration.file, { force: true });
  fs.rmSync(snapshotFile(folder, Number.parseInt(migration.tag, 10)), {
    force: true,
  });
  if (journalBefore !== null) {
    writeFileAtomic(journalFile(folder), journalBefore);
    return;
  }
  fs.rmSync(journalFile(folder), { force: true });
  for (const dir of [metaFolder(folder), folder]) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0)
      fs.rmdirSync(dir);
  }
}
