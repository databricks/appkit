import { Command } from "commander";
import { metricViewsSyncCommand } from "./sync/sync";

/**
 * Parent command for UC Metric View operations.
 *
 * Exposes a single subcommand (`sync`).
 * Future subcommands (`list` / `validate` / `describe`) plug in here so users have one top-level surface for everything related to Metric Views.
 * Sibling of `plugin`, `setup`, `generate-types`, `lint`, `docs`, `codemod`.
 */
export const metricViewsCommand = new Command("mv")
  .description("Metric-view management commands (UC Metric Views)")
  .addCommand(metricViewsSyncCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit mv sync --warehouse-id 1234abcd5678efgh`,
  );
