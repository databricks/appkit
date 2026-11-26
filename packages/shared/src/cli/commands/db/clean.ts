import { Command } from "commander";

import { loadDatabaseTooling } from "./load-tooling";
import {
  fail,
  info,
  isInteractive,
  ok,
  printCleanReport,
  shortName,
  warn,
} from "./output";

interface CleanFlags {
  readonly yes?: boolean;
  readonly deleteBranch?: boolean;
}

async function runDbClean(flags: CleanFlags): Promise<void> {
  try {
    const tooling = await loadDatabaseTooling();
    const ctx = tooling.createDbContext();
    if (flags.deleteBranch) {
      const { branch } = await tooling.deleteSessionBranch(ctx);
      ok(`Deleted ${shortName(branch)}`);
      info("`appkit db init --session` creates a new one");
      return;
    }
    if (!flags.yes) {
      if (!isInteractive()) {
        throw new Error(
          "Refusing to clean without confirmation in a non-interactive shell. Pass --yes.",
        );
      }
      const preview = await tooling.previewClean(ctx);
      if (preview.dependents.length > 0) {
        warn(
          `Dropping schema ${preview.schemaName} also removes these objects outside it, which depend on it: ${preview.dependents.join(", ")}`,
        );
      }
      const { confirm, isCancel } = await import("@clack/prompts");
      const answer = await confirm({
        message: `Remove every object in schema ${preview.schemaName} on ${shortName(preview.branch)}, including the migration journal?`,
        initialValue: false,
      });
      if (isCancel(answer) || !answer) {
        info("Cancelled");
        process.exitCode = 1;
        return;
      }
    }
    printCleanReport(await tooling.runClean(ctx));
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
  .option(
    "--delete-branch",
    "delete this checkout's session branch instead, e.g. at the end of a CI job",
  )
  .addHelpText(
    "after",
    `
Only branches \`appkit db init\` created for you (dev-… or session-…) can be cleaned;
the default, protected and deploy branches are always refused. Objects outside
the schema that depend on it, such as a view in another schema, are dropped
with it and listed. --delete-branch deletes session branches only; your dev
branch stays.

Examples:
  $ appkit db clean
  $ appkit db init --session --ttl 1h --yes && npm test && appkit db clean --delete-branch`,
  )
  .action(runDbClean);
