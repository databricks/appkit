import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

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
import { hasUnmigratedChanges, ORIGIN_ID } from "./migrations";

export interface CheckReport {
  /** Committed migrations, in journal order. */
  readonly migrations: readonly string[];
  /** What is wrong with the committed history, each with its fix. */
  readonly problems: readonly string[];
  readonly ok: boolean;
}

const REWRITE =
  "Save any SQL you wrote by hand in your migration. Merge the base branch, reset the migrations to its own (for example `git restore --source origin/main --staged --worktree config/database/migrations`), then run `appkit db clean` and `appkit db migrate`, which writes your schema change again after the base branch's migrations and applies them all to your rebuilt branch. Add the saved SQL back to the regenerated migration and review its SQL before you commit.";

/** Entries numbered or ordered in a way the migrator or drizzle-kit misreads. */
function orderProblems(entries: readonly JournalEntry[]): string[] {
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    if (entry.idx !== index) {
      problems.push(
        `${entry.tag} is entry ${index} of meta/_journal.json, but its idx is ${entry.idx}, so drizzle-kit reads another snapshot for it. ${REWRITE}`,
      );
    }
    // The journal is parsed, not validated, so `when` can hold anything.
    if (!Number.isSafeInteger(entry.when)) {
      problems.push(
        `The when of ${entry.tag} in meta/_journal.json is ${JSON.stringify(entry.when) ?? "missing"}, not an integer timestamp, so the migrator never runs it. ${REWRITE}`,
      );
      return;
    }
    const before = entries[index - 1];
    if (
      before &&
      Number.isSafeInteger(before.when) &&
      entry.when <= before.when
    ) {
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

/** drizzle-kit's PostgreSQL v7 snapshot, as far as telling it from a stub needs. */
const snapshotShape = z.object({
  version: z.literal("7"),
  dialect: z.literal("postgresql"),
  id: z.string(),
  prevId: z.string(),
  tables: z.record(z.string(), z.unknown()),
  enums: z.record(z.string(), z.unknown()),
  schemas: z.record(z.string(), z.unknown()),
});

/** The empty database drizzle-kit diffs the first migration from. */
const ORIGIN: SnapshotLink = { id: ORIGIN_ID, prevId: "" };

/**
 * Each snapshot must follow the one before it, and the first one the empty
 * database. Two migrations generated from the same snapshot on parallel
 * branches both follow that one, so the later one was written without the
 * other's changes.
 */
function chainProblems(
  entries: readonly JournalEntry[],
  links: readonly (SnapshotLink | null)[],
): string[] {
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    const link = links[index];
    const before = index === 0 ? ORIGIN : links[index - 1];
    if (!link || !before || link.prevId === before.id) return;
    if (index === 0) {
      problems.push(
        `${entry.tag} is the first entry of meta/_journal.json but was not generated from an empty database, so the migrations before it are missing. Restore them from version control.`,
      );
      return;
    }
    const parent = links.findIndex((other) => other?.id === link.prevId);
    const after =
      link.prevId === ORIGIN_ID
        ? "from an empty database"
        : parent === -1
          ? "after a snapshot that is not committed"
          : `after ${entries[parent]?.tag ?? "an earlier snapshot"}`;
    problems.push(
      `${entry.tag} was generated ${after}, not after ${entries[index - 1]?.tag}: they were written on parallel branches, so ${entry.tag} lacks the other's changes. ${REWRITE}`,
    );
  });
  return problems;
}

/**
 * `appkit db check`: the committed migrations are in order, every file they
 * list is committed, and schema.ts has no change without a migration. It
 * imports schema.ts and needs no Databricks or Lakebase access, so CI runs it
 * on every pull request.
 */
export async function runCheck(ctx: DbContext): Promise<CheckReport> {
  requireSchemaFile(ctx.root, "check");
  const folder = migrationsFolder(ctx.root);
  const shown = (file: string) => path.relative(ctx.root, file);
  const entries = readJournal(folder)?.entries ?? [];
  const problems = orderProblems(entries);

  const links = entries.map((entry): SnapshotLink | null => {
    const file = snapshotFile(folder, entry.idx);
    if (!fs.existsSync(file)) {
      problems.push(
        `${shown(file)}, the snapshot of ${entry.tag}, is not committed. Restore it from version control: the next migration is generated from it.`,
      );
      return null;
    }
    const snapshot = snapshotShape.safeParse(readJsonFile<unknown>(file));
    if (snapshot.success) {
      return { id: snapshot.data.id, prevId: snapshot.data.prevId };
    }
    problems.push(
      `${shown(file)}, the snapshot of ${entry.tag}, is not a drizzle-kit snapshot. Restore it from version control.`,
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
