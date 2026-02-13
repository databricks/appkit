import { Command } from "commander";
import { pluginAddResourceCommand } from "./plugin-add-resource.js";
import { pluginCreateCommand } from "./plugin-create.js";
import { pluginListCommand } from "./plugin-list.js";
import { pluginValidateCommand } from "./plugin-validate.js";
import { pluginsSyncCommand } from "./plugins-sync.js";

/**
 * Parent command for plugin management operations.
 * Subcommands:
 *   - sync: Aggregate plugin manifests into appkit.plugins.json
 *   - create: Scaffold a new plugin (interactive)
 *   - validate: Validate manifest(s) against the JSON schema
 *   - list: List plugins from appkit.plugins.json or a directory
 *   - add-resource: Add a resource requirement to a plugin manifest (interactive)
 */
export const pluginCommand = new Command("plugin")
  .description("Plugin management commands")
  .addCommand(pluginsSyncCommand)
  .addCommand(pluginCreateCommand)
  .addCommand(pluginValidateCommand)
  .addCommand(pluginListCommand)
  .addCommand(pluginAddResourceCommand);
