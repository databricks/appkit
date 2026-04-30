import { Command } from "commander";
import { pluginAddResourceCommand } from "./add-resource/add-resource";
import { pluginCreateCommand } from "./create/create";
import { pluginListCommand } from "./list/list";
import { pluginPromoteCommand } from "./promote/promote";
import { pluginsSyncCommand } from "./sync/sync";
import { pluginValidateCommand } from "./validate/validate";

/**
 * Parent command for plugin management operations.
 * Subcommands:
 *   - sync: Aggregate plugin manifests into appkit.plugins.json
 *   - create: Scaffold a new plugin (interactive)
 *   - validate: Validate manifest(s) against the JSON schema
 *   - list: List plugins from appkit.plugins.json or a directory
 *   - add-resource: Add a resource requirement to a plugin manifest (interactive)
 *   - promote: Promote a plugin to a higher stability tier
 */
export const pluginCommand = new Command("plugin")
  .description("Plugin management commands")
  .addCommand(pluginsSyncCommand)
  .addCommand(pluginCreateCommand)
  .addCommand(pluginValidateCommand)
  .addCommand(pluginListCommand)
  .addCommand(pluginAddResourceCommand)
  .addCommand(pluginPromoteCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit plugin sync --write
  $ appkit plugin create --placement in-repo --path plugins/my-plugin --name my-plugin --description "Does X"
  $ appkit plugin validate .
  $ appkit plugin list --json
  $ appkit plugin add-resource --path plugins/my-plugin --type sql_warehouse
  $ appkit plugin promote my-plugin --to ga`,
  );
