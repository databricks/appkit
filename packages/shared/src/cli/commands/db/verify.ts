import { Command } from "commander";

import { fail, printVerifyReport } from "./output";

async function runDbVerify(options: { prod?: boolean }): Promise<void> {
  try {
    const tooling = await import("@databricks/appkit/database-tooling");
    const report = await tooling.runVerify(tooling.createDbContext(), {
      prod: options.prod === true,
    });
    printVerifyReport(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
}

export const dbVerifyCommand = new Command("verify")
  .description(
    "Check the .env branch against config/database/schema.ts and the committed migrations (read-only)",
  )
  .option(
    "--prod",
    "check instead that the deployed app is set up to use the deploy branch from databricks.yml",
  )
  .addHelpText(
    "after",
    `
Reports declared tables or columns the branch lacks (what the app checks on
start), committed migrations the branch has not applied, and migrations it will
never run (merged out of order, or edited after they ran).

--prod reads only the Databricks API, so it needs no access to the deploy
branch's database: the app exists, its postgres resource names the branch and
database in databricks.yml with CAN_CONNECT_AND_CREATE, its service principal
has a role on the branch, and the app is running. A running app has applied
its migrations and checked its schema on start.

Exits 1 on any finding. Nothing is written or created.

Examples:
  $ appkit db verify
  $ appkit db verify --prod`,
  )
  .action(runDbVerify);
