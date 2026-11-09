import { Command } from "commander";

import { loadDatabaseTooling } from "./load-tooling";
import {
  fail,
  isInteractive,
  printMigrateReport,
  warnBreaking,
} from "./output";
import type { UnappliedMigration } from "./tooling-contract";

/** The migration a failed run wrote and kept; null when it wrote none. */
function unappliedMigration(error: unknown): UnappliedMigration | null {
  const candidate = error as Partial<UnappliedMigration> | null;
  return typeof candidate?.generated?.tag === "string" &&
    Array.isArray(candidate.breaking)
    ? (candidate as UnappliedMigration)
    : null;
}

async function runDbMigrate(): Promise<void> {
  try {
    const tooling = await loadDatabaseTooling();
    const report = await tooling.runMigrate(tooling.createDbContext(), {
      interactive: isInteractive(),
    });
    printMigrateReport(report);
  } catch (error) {
    fail(error);
    const kept = unappliedMigration(error);
    if (kept) warnBreaking(kept.generated.tag, kept.breaking);
  }
}

export const dbMigrateCommand = new Command("migrate")
  .description(
    "Generate a migration from config/database/schema.ts, apply pending migrations to the .env branch, and regenerate database.d.ts",
  )
  .addHelpText(
    "after",
    `
Migrations are written to config/database/migrations/. Commit them with schema.ts;
the deployed app applies pending committed migrations when it starts. They are
applied locally only on your dev or session branch (see \`appkit db init\`).

Examples:
  $ appkit db migrate`,
  )
  .action(runDbMigrate);
