import { Command } from "commander";

import { fail, isInteractive, printIntrospectReport } from "./output";

async function runDbIntrospect(flags: { schemaName?: string }): Promise<void> {
  try {
    const tooling = await import("@databricks/appkit/database-tooling");
    const report = await tooling.runIntrospect(tooling.createDbContext(), {
      interactive: isInteractive(),
      ...(flags.schemaName ? { schemaName: flags.schemaName } : {}),
    });
    printIntrospectReport(report);
  } catch (error) {
    fail(error);
  }
}

export const dbIntrospectCommand = new Command("introspect")
  .description(
    "Write config/database/schema.ts from the .env branch's tables, plus the migration that brings history up to them",
  )
  .option("--schema-name <name>", "Postgres schema to read (default: app)")
  .addHelpText(
    "after",
    `
The previous schema.ts is kept as schema.ts.bak. What the schema builder cannot
express (composite keys, unsupported types or defaults, some foreign keys) is left
out with an "// appkit: skipped …" comment.

Without migration history this writes 0000_baseline; with history, the next
NNNN_introspect, once the branch has applied every committed migration. On your
dev or session branch the migration is recorded as applied. On any other branch
only 0000_baseline is written, and the deployed app adopts it on start when its
tables already exist. If anything fails, schema.ts and the migrations are left
as they were.

Examples:
  $ appkit db introspect
  $ appkit db introspect --schema-name sales`,
  )
  .action(runDbIntrospect);
