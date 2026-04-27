import { Command } from "commander";
import { onPluginsReadyCommand } from "./on-plugins-ready";

/**
 * Parent command for codemod operations.
 * Subcommands:
 *   - on-plugins-ready: Migrate from autoStart/extend/start to onPluginsReady callback
 */
export const codemodCommand = new Command("codemod")
  .description("Run codemods to migrate to newer AppKit APIs")
  .addCommand(onPluginsReadyCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit codemod on-plugins-ready --write`,
  );
