import fs from "node:fs";
import process from "node:process";
import { Command } from "commander";
import dotenv from "dotenv";
import { exitCodeFor, printReport, printReportJson } from "./report";
import { runDoctor } from "./run";
import type { DoctorOptions } from "./types";

/**
 * Loads an explicit env file into `process.env`, overriding the `.env` the CLI
 * auto-loads at startup so doctor checks the same environment the app runs with.
 * @throws if the file is missing — an explicit `--env-file` that doesn't exist
 * is a mistake worth surfacing, not silently ignoring.
 */
export function loadEnvFile(envFile: string): void {
  if (!fs.existsSync(envFile)) {
    throw new Error(`env file not found: ${envFile}`);
  }
  dotenv.config({ path: envFile, override: true });
}

async function runDoctorCommand(options: DoctorOptions): Promise<void> {
  if (options.envFile) loadEnvFile(options.envFile);

  const report = await runDoctor(options);

  if (options.json) {
    printReportJson(report);
  } else {
    printReport(report, options.detail);
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
  .option(
    "-e, --env-file <path>",
    "Load this env file before checking (overrides the auto-loaded .env), e.g. .env.local",
  )
  .option(
    "-d, --detail",
    "Show full underlying error messages (raw SDK output) for failures",
  )
  .option("--json", "Output the diagnostic report as JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit doctor
  $ appkit doctor --profile my-profile
  $ appkit doctor --env-file .env.local
  $ appkit doctor --detail
  $ appkit doctor --json`,
  )
  .action((opts: DoctorOptions) =>
    runDoctorCommand(opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
