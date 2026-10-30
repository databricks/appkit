import { Command } from "commander";

import { loadDatabaseTooling } from "./load-tooling";
import { fail, printCheckReport } from "./output";

async function runDbCheck(): Promise<void> {
  try {
    const tooling = await loadDatabaseTooling();
    const report = await tooling.runCheck(tooling.createDbContext());
    printCheckReport(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
}

export const dbCheckCommand = new Command("check")
  .description(
    "Check the committed migrations against config/database/schema.ts, offline (for CI)",
  )
  .addHelpText(
    "after",
    `
Reads only the checkout, so it needs no Databricks or Lakebase access, only
the app's installed dependencies (drizzle-kit included). It fails when:
  - the journal lists a migration generated before the one listed ahead of it;
  - two migrations were generated from the same snapshot on parallel branches;
  - an entry's idx is not its position in the journal;
  - a migration's .sql or snapshot is not committed, a snapshot is not a
    drizzle-kit snapshot, or a .sql is not in the journal;
  - schema.ts changed and no committed migration has the change.

Exits 1 on any finding. Nothing is written.

Examples:
  $ appkit db check`,
  )
  .action(runDbCheck);
