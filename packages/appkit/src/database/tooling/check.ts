import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_SCHEMA_FILE,
  loadDefaultDatabaseSchema,
} from "../../plugins/database/load-schema";
import {
  type JournalEntry,
  migrationFile,
  migrationsFolder,
  readJournal,
  readJsonFile,
  snapshotFile,
} from "../migrations/paths";
import type { DbContext } from "./context";
import { requireSchemaFile } from "./migrate";
import { hasUnmigratedChanges } from "./migrations";

export interface CheckReport {
  /** Committed migrations, in journal order. */
  readonly migrations: readonly string[];
  /** What is wrong with the committed history, each with its fix. */
  readonly problems: readonly string[];
  readonly ok: boolean;
}

const REWRITE =
  "Merge the base branch, reset the migrations to its own (for example `git restore --source origin/main --staged --worktree config/database/migrations`), then run `appkit db clean` and `appkit db migrate`: migrate writes your change again after the base branch's migrations, and applies them all to your rebuilt branch.";

/** Entries numbered or ordered in a way the migrator or drizzle-kit misreads. */
function orderProblems(entries: readonly JournalEntry[]): string[] {
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    if (entry.idx !== index) {
      problems.push(
        `${entry.tag} is entry ${index} of meta/_journal.json, but its idx is ${entry.idx}, so drizzle-kit reads another snapshot for it. ${REWRITE}`,
      );
    }
    const before = entries[index - 1];
    if (before && entry.when <= before.when) {
      problems.push(
        `${entry.tag} is listed after ${before.tag} but was generated before it, so a branch that ran ${before.tag} never runs ${entry.tag}. ${REWRITE}`,
      );
    }
  });
  return problems;
}

/** The parts of a snapshot that chain it to the one before. */
interface SnapshotLink {
  readonly id: string;
  readonly prevId: string;
}

/**
 * Each snapshot must follow the one before it. Two migrations generated from
 * the same snapshot on parallel branches both follow that one, so the later
 * one was written without the other's changes.
 */
function chainProblems(
  entries: readonly JournalEntry[],
  links: readonly (SnapshotLink | null)[],
): string[] {
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    const link = links[index];
    const before = links[index - 1];
    if (!link || !before || link.prevId === before.id) return;
    const parent = links.findIndex((other) => other?.id === link.prevId);
    const after =
      parent === -1
        ? "a snapshot that is not committed"
        : (entries[parent]?.tag ?? "an earlier snapshot");
    problems.push(
      `${entry.tag} was generated after ${after}, not after ${entries[index - 1]?.tag}: they were written on parallel branches, so ${entry.tag} lacks the other's changes. ${REWRITE}`,
    );
  });
  return problems;
}

/**
 * `appkit db check`: the committed migrations are in order, every file they
 * list is committed, and schema.ts has no change without a migration. It reads
 * only files, so CI can run it without Databricks or Lakebase access.
 */
export async function runCheck(ctx: DbContext): Promise<CheckReport> {
  requireSchemaFile(ctx.root, "check");
  const folder = migrationsFolder(ctx.root);
  const shown = (file: string) => path.relative(ctx.root, file);
  const entries = readJournal(folder)?.entries ?? [];
  const problems = orderProblems(entries);

  const links = entries.map((entry) => {
    const file = snapshotFile(folder, entry.idx);
    if (fs.existsSync(file)) return readJsonFile<SnapshotLink>(file);
    problems.push(
      `${shown(file)}, the snapshot of ${entry.tag}, is not committed. Restore it from version control: the next migration is generated from it.`,
    );
    return null;
  });
  for (const entry of entries) {
    const file = migrationFile(folder, entry.tag);
    if (!fs.existsSync(file)) {
      problems.push(
        `${shown(file)} is listed in meta/_journal.json but not committed. Restore it from version control.`,
      );
    }
  }
  const listed = new Set(entries.map((entry) => `${entry.tag}.sql`));
  const unlisted = fs.existsSync(folder)
    ? fs
        .readdirSync(folder)
        .filter((name) => name.endsWith(".sql") && !listed.has(name))
        .sort()
    : [];
  for (const name of unlisted) {
    problems.push(
      `${shown(path.join(folder, name))} is not in meta/_journal.json, so no deploy runs it. ${REWRITE}`,
    );
  }
  problems.push(...chainProblems(entries, links));

  // drizzle-kit diffs from the latest snapshot, which must exist.
  if (entries.length === 0 || links.at(-1)) {
    const schema = await loadDefaultDatabaseSchema(ctx.root, {
      showImportError: true,
    });
    if (await hasUnmigratedChanges(folder, schema)) {
      const last = entries.at(-1)?.tag;
      problems.push(
        `${DEFAULT_SCHEMA_FILE} changed ${last ? `since ${last}` : "and no migration is committed"}, so the deployed app would not get the change. Run \`appkit db migrate\` and commit the migration it writes.`,
      );
    }
  }

  return {
    migrations: entries.map((entry) => entry.tag),
    problems,
    ok: problems.length === 0,
  };
}
