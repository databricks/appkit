import { Command } from "commander";

import { loadDatabaseTooling } from "./load-tooling";
import { fail, ok, relative, shortName } from "./output";

async function runDbSeed(): Promise<void> {
  try {
    const tooling = await loadDatabaseTooling();
    const report = await tooling.runSeed(tooling.createDbContext());
    ok(`Ran ${relative(report.file)} on ${shortName(report.branch)}`);
  } catch (error) {
    fail(error);
  }
}

export const dbSeedCommand = new Command("seed")
  .description(
    "Run config/database/seed.sql in one transaction on your dev or session branch",
  )
  .addHelpText(
    "after",
    `
Unqualified names resolve to the app schema first (app, or the schemaName in
config/database/schema.ts), then public. The file already runs in one
transaction, so it must not contain BEGIN or COMMIT.`,
  )
  .action(runDbSeed);
