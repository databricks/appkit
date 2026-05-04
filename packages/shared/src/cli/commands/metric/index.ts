import { Command } from "commander";
import { metricSyncCommand } from "./sync/sync";

/**
 * Parent command for metric-view operations.
 *
 * Currently exposes a single subcommand (`sync`); future v1+ subcommands
 * (`list`, `validate`, `describe`) plug in here so users have a single
 * top-level surface for everything related to UC Metric Views.
 *
 * Sibling of `plugin`, `setup`, `generate-types`, `lint`, `docs`, `codemod`.
 */
export const metricCommand = new Command("metric")
  .description("Metric-view management commands (UC Metric Views)")
  .addCommand(metricSyncCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit metric sync
  $ appkit metric sync --warehouse-id 1234abcd5678efgh --metric-json-path config/queries/metric.json
  $ appkit metric sync --silent`,
  );
