import { Command } from "commander";
import { generateCommand } from "./generate";
import { introspectCommand } from "./introspect";
import { migrateCommand } from "./migrate";
import { verifyCommand } from "./verify";

/**
 * Parent command for Lakebase database operations.
 */
export const dbCommand = new Command("db")
  .description("Database (Lakebase) management commands")
  .addCommand(introspectCommand)
  .addCommand(generateCommand)
  .addCommand(migrateCommand)
  .addCommand(verifyCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit db introspect
  $ appkit db generate --name add_phone
  $ appkit db migrate up
  $ appkit db verify`,
  );
