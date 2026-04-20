import { Command } from "commander";
import { customizeCallbackCommand } from "./customize-callback";

/**
 * Parent command for codemod operations.
 * Subcommands:
 *   - customize-callback: Migrate from autoStart/extend/start to onPluginsReady callback
 */
export const codemodCommand = new Command("codemod")
  .description("Run codemods to migrate to newer AppKit APIs")
  .addCommand(customizeCallbackCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit codemod customize-callback --write`,
  );
