import { Command } from "commander";

import { loadDatabaseTooling } from "./load-tooling";
import { fail, printVerifyReport } from "./output";

async function runDbVerify(options: {
  deployed?: boolean;
  target?: string;
}): Promise<void> {
  try {
    if (options.target && !options.deployed) {
      throw new Error(
        "--target picks the databricks.yml target --deployed checks; pass --deployed with it.",
      );
    }
    const tooling = await loadDatabaseTooling();
    const report = await tooling.runVerify(tooling.createDbContext(), {
      deployed: options.deployed === true,
      ...(options.target ? { target: options.target } : {}),
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
    "--deployed",
    "check instead the app a databricks.yml target deploys, and its branch",
  )
  .option(
    "-t, --target <name>",
    "the databricks.yml target --deployed checks (default: the bundle's default target)",
  )
  .addHelpText(
    "after",
    `
Reports declared tables or columns the branch lacks (what the app checks on
start), committed migrations the branch has not applied, migrations it will
never run (merged out of order, or edited after they ran), and migrations it
ran that this checkout does not commit.

--deployed reads only the Databricks API, so it needs no access to the deploy
branch's database. It checks that the target's app exists, that its postgres
resource names the branch and database in databricks.yml with
CAN_CONNECT_AND_CREATE, that its service principal has a role on the branch,
that the app is running, and that the source its active deployment runs has
every committed migration, with the same journal entry and SQL. When verify
cannot read that source, it fails. It refuses when the target's
workspace.host is not the workspace this shell is authenticated against.

Exits 1 on any finding. Nothing is written or created.

Examples:
  $ appkit db verify
  $ appkit db verify --deployed
  $ appkit db verify --deployed -t prod`,
  )
  .action(runDbVerify);
