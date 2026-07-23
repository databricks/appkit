import process from "node:process";
import { Command } from "commander";
import { exitCodeFor, printReport, printReportJson } from "./report";
import { runDoctor } from "./run";
import type { DoctorOptions } from "./types";

async function runDoctorCommand(options: DoctorOptions): Promise<void> {
  const report = await runDoctor(options);

  if (options.json) {
    printReportJson(report);
  } else {
    printReport(report);
  }

  process.exit(exitCodeFor(report));
}

export const doctorCommand = new Command("doctor")
  .description(
    "Diagnose an AppKit app's Databricks resources: authentication, config, and resource existence/reachability",
  )
  .option(
    "-m, --manifest <path>",
    "Path to the resolved template manifest",
    "appkit.plugins.json",
  )
  .option("-p, --profile <name>", "Databricks CLI profile to authenticate with")
  .option("--json", "Output the diagnostic report as JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit doctor
  $ appkit doctor --profile my-profile
  $ appkit doctor --json`,
  )
  .action((opts: DoctorOptions) =>
    runDoctorCommand(opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
