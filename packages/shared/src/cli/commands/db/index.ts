import { Command } from "commander";
import { initCommand } from "./init";
import { introspectCommand } from "./introspect";
import { migrateCommand } from "./migrate";
import { migrationCommand } from "./migration";
import { seedCommand } from "./seed";
import { setupDevCommand } from "./setup-dev";
import { verifyCommand } from "./verify";

/**
 * Parent command for Lakebase database operations.
 */
export const dbCommand = new Command("db")
  .description("Database (Lakebase) management commands")
  .addCommand(initCommand)
  .addCommand(introspectCommand)
  .addCommand(migrationCommand)
  .addCommand(migrateCommand)
  .addCommand(seedCommand)
  .addCommand(setupDevCommand)
  .addCommand(verifyCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit db init                           # one-command onboarding (interactive)
  $ appkit db introspect
  $ appkit db migration generate --name init
  $ appkit db migrate up
  $ appkit db seed
  $ appkit db setup:dev --seed --name init
  $ appkit db verify`,
  );
