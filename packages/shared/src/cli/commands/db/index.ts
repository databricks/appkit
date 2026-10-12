import { Command } from "commander";

import { dbCleanCommand } from "./clean";
import { dbInitCommand } from "./init";
import { dbIntrospectCommand } from "./introspect";
import { dbMigrateCommand } from "./migrate";
import { dbSeedCommand } from "./seed";

/**
 * Lakebase database lifecycle for the DatabasePlugin. The logic lives in
 * `@databricks/appkit/database-tooling`; these commands only parse, prompt and print.
 */
export const dbCommand = new Command("db")
  .description("Lakebase database lifecycle")
  .addCommand(dbInitCommand)
  .addCommand(dbMigrateCommand)
  .addCommand(dbIntrospectCommand)
  .addCommand(dbCleanCommand)
  .addCommand(dbSeedCommand);
