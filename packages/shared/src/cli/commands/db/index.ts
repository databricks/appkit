import { Command } from "commander";

import { dbMigrateCommand } from "./migrate";

/**
 * Lakebase database lifecycle for the DatabasePlugin. The logic lives in
 * `@databricks/appkit/database-tooling`; these commands only parse, prompt and print.
 */
export const dbCommand = new Command("db")
  .description("Lakebase database lifecycle")
  .addCommand(dbMigrateCommand);
