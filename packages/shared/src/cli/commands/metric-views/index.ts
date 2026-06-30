import { Command } from "commander";
import { metricViewsSyncCommand } from "./sync/sync";

/**
 * Parent command for UC Metric View operations.
 *
 * Exposes a single subcommand (`sync`).
 * Future subcommands (`list` / `validate` / `describe`) plug in here so users have one top-level surface for everything related to Metric Views.
 * Sibling of `plugin`, `setup`, `generate-types`, `lint`, `docs`, `codemod`.
 */
export const metricViewsCommand = new Command("metric-views")
  // `metric-views` is the canonical name shown in --help (full-word, consistent
  // with `plugin` / `generate-types`); `mv` is the ergonomic shorthand alias.
  .alias("mv")
  .description("Metric-view management commands (UC Metric Views)")
  .addCommand(metricViewsSyncCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit metric-views sync --warehouse-id 1234abcd5678efgh
  $ appkit mv sync --warehouse-id 1234abcd5678efgh   # 'mv' is a shorthand alias`,
  );
