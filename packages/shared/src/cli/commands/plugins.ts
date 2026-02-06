import { Command } from "commander";
import { pluginsSyncCommand } from "./plugins-sync.js";

/**
 * Parent command for plugin management operations.
 * Subcommands:
 *   - sync: Aggregate plugin manifests into appkit.plugins.json
 *
 * Future subcommands may include:
 *   - add: Add a plugin to an existing project
 *   - remove: Remove a plugin from a project
 *   - list: List available plugins
 */
export const pluginsCommand = new Command("plugins")
  .description("Plugin management commands")
  .addCommand(pluginsSyncCommand);
