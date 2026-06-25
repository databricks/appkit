import { Command } from "commander";
import { registryListCommand } from "./list";

/**
 * Parent command for AppKit component registry operations.
 * Subcommands:
 *   - list: Enumerate components available in the registry
 *
 * Note: `appkit add <component>` is exposed as a top-level command (see add.ts)
 * since it is the primary entry point for consumers.
 */
export const registryCommand = new Command("registry")
  .description("AppKit component registry commands")
  .addCommand(registryListCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit registry list
  $ appkit registry list --json
  $ appkit add metric-card`,
  );
