import { Command } from "commander";

import { registryInfoCommand } from "./info";
import { registryListCommand, registrySearchCommand } from "./list";

/**
 * Parent command for AppKit component registry operations.
 * Subcommands:
 *   - list: Enumerate items available in the registry
 *   - search: Find items by name, description, type, or keyword
 *   - info: Show an item's resource requirements and dependencies
 *
 * Note: `appkit add <item>` is exposed as a top-level command (see add.ts)
 * since it is the primary entry point for consumers.
 */
export const registryCommand = new Command("registry")
  .description("AppKit component registry commands")
  .addCommand(registryListCommand)
  .addCommand(registrySearchCommand)
  .addCommand(registryInfoCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit registry list
  $ appkit registry search kpi dashboard
  $ appkit registry info analytics
  $ appkit add metric-card`,
  );
