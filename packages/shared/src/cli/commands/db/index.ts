import { Command } from "commander";

import { dbCheckCommand } from "./check";
import { dbCleanCommand } from "./clean";
import { dbInitCommand } from "./init";
import { dbIntrospectCommand } from "./introspect";
import { dbMigrateCommand } from "./migrate";
import { dbSeedCommand } from "./seed";
import { dbVerifyCommand } from "./verify";

export const dbCommand = new Command("db")
  .description("Lakebase database lifecycle")
  .addCommand(dbInitCommand)
  .addCommand(dbMigrateCommand)
  .addCommand(dbIntrospectCommand)
  .addCommand(dbCleanCommand)
  .addCommand(dbSeedCommand)
  .addCommand(dbVerifyCommand)
  .addCommand(dbCheckCommand);
