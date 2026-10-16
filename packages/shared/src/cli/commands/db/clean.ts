import { Command } from "commander";

import { fail, info, isInteractive, ok, shortName } from "./output";

function envBranchLabel(): string {
  const endpoint = process.env.LAKEBASE_ENDPOINT ?? "";
  const match = /\/branches\/([^/]+)/.exec(endpoint);
  return match?.[1] ? `branch ${match[1]}` : "the .env branch";
}

async function runDbClean(flags: { yes?: boolean }): Promise<void> {
  try {
    if (!flags.yes) {
      if (!isInteractive()) {
        throw new Error(
          "Refusing to clean without confirmation in a non-interactive shell. Pass --yes.",
        );
      }
      const { confirm, isCancel } = await import("@clack/prompts");
      const answer = await confirm({
        message: `Remove every object in the app schema of ${envBranchLabel()}, including the migration journal?`,
        initialValue: false,
      });
      if (isCancel(answer) || !answer) {
        info("Cancelled");
        return;
      }
    }
    const tooling = await import("@databricks/appkit/database-tooling");
    const report = await tooling.runClean(tooling.createDbContext());
    ok(
      `Removed every object in schema ${report.schemaName} on ${shortName(report.branch)}`,
    );
    info("`appkit db migrate` recreates it from the committed migrations");
  } catch (error) {
    fail(error);
  }
}

export const dbCleanCommand = new Command("clean")
  .description(
    "Remove every object in the app schema, including the migration journal, on your dev or session branch",
  )
  .option("-y, --yes", "skip the confirmation")
  .addHelpText(
    "after",
    `
Only branches \`appkit db init\` created for you (dev-… or session-…) can be cleaned;
the default, protected and deploy branches are always refused.`,
  )
  .action(runDbClean);
