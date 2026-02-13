import { Command } from "commander";
import { pluginCreateCommand } from "./plugin-create.js";
import { pluginsSyncCommand } from "./plugins-sync.js";

/**
 * Parent command for plugin management operations.
 * Subcommands:
 *   - sync: Aggregate plugin manifests into appkit.plugins.json
 *   - create: Scaffold a new plugin (interactive)
 */
export const pluginCommand = new Command("plugin")
  .description("Plugin management commands")
  .addCommand(pluginsSyncCommand)
  .addCommand(pluginCreateCommand);
