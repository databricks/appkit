import fs from "node:fs";
import process from "node:process";
import { Command } from "commander";
import dotenv from "dotenv";
import { printReport, printReportJson } from "./report";
import { runDoctor } from "./run";
import type { DoctorOptions } from "./types";

/**
 * Loads an explicit env file into `process.env`, overriding the auto-loaded
 * `.env`. Throws if the file is missing.
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
    printReportJson(report, options.detail);
  } else {
    printReport(report, options.detail);
  }

  process.exit(report.exitCode);
}

export const doctorCommand = new Command("doctor")
  .description(
    "Diagnose an AppKit app's Databricks resources: authentication, config, and resource existence/reachability",
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
