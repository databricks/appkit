import { Command } from "commander";
import { agentEvalCommand } from "./eval";

/**
 * Parent command for agent development operations.
 * Subcommands:
 *   - eval: Run agent evals against a running app
 */
export const agentCommand = new Command("agent")
  .description("Agent development commands")
  .addCommand(agentEvalCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit agent eval
  $ appkit agent eval support --strict
  $ appkit agent eval --url https://my-app.databricksapps.com`,
  );
