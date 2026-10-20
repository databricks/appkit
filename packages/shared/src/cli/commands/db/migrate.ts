import { Command } from "commander";

import { loadDatabaseTooling } from "./load-tooling";
import { fail, isInteractive, printMigrateReport } from "./output";

async function runDbMigrate(): Promise<void> {
  try {
    const tooling = await loadDatabaseTooling();
    const report = await tooling.runMigrate(tooling.createDbContext(), {
      interactive: isInteractive(),
    });
    printMigrateReport(report);
  } catch (error) {
    fail(error);
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
