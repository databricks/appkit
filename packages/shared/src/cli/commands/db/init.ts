import { Command, Option } from "commander";

import { loadDatabaseTooling } from "./load-tooling";
import {
  fail,
  info,
  isInteractive,
  ok,
  printCleanReport,
  printIntrospectReport,
  printMigrateReport,
  shortName,
} from "./output";
import type { InitOptions, InitReport, SchemaStart } from "./tooling-contract";

interface InitFlags {
  readonly session?: boolean;
  readonly dev?: boolean;
  readonly ttl?: string;
  readonly schema?: SchemaStart;
  readonly yes?: boolean;
}

/** --schema clean drops data: a human confirms it, a script passes --yes. */
async function confirmClean(flags: InitFlags): Promise<boolean> {
  if (flags.schema !== "clean" || flags.yes) return true;
  if (!isInteractive()) {
    throw new Error(
      "Refusing to run `--schema clean` without confirmation in a non-interactive shell. Pass --yes.",
    );
  }
  const { confirm, isCancel } = await import("@clack/prompts");
  const answer = await confirm({
    message:
      "Drop the app schema on your dev or session branch, with every table and row in it, then apply the committed migrations?",
    initialValue: false,
  });
  return !isCancel(answer) && answer;
}

function printInitReport(report: InitReport): void {
  const branch = shortName(report.branch);
  const expires = report.expireTime ? `, expires ${report.expireTime}` : "";
  ok(
    report.created
      ? `Branch ${branch} (created from ${shortName(report.sourceBranch ?? "the default branch")}${expires})`
      : `Branch ${branch} (reused${expires})`,
  );
  ok(
    `Endpoint ${shortName(report.endpoint)}${report.endpointCreated ? " (created)" : ""}: ${report.host}`,
  );
  const role = {
    created: "created",
    updated: "added to DATABRICKS_SUPERUSER",
    kept: "DATABRICKS_SUPERUSER",
  }[report.role.action];
  ok(`Role ${report.user} (${role})`);
  if (report.handedOff) {
    ok(`The app schema is yours: it belonged to ${report.handedOff}`);
  }
  ok(`Pointed .env at ${branch} (database ${report.database})`);
  if (report.installed) ok(`Installed drizzle-kit (${report.installed})`);

  const { start } = report;
  if (start.kind === "introspect") printIntrospectReport(start.introspect);
  else if (start.kind === "migrate") printMigrateReport(start.migrate);
  else if (start.kind === "clean") {
    printCleanReport(start.clean);
    printMigrateReport(start.migrate);
  } else info("Left the schema as it is");
}

async function runDbInit(flags: InitFlags): Promise<void> {
  try {
    if (!(await confirmClean(flags))) {
      info("Cancelled");
      process.exitCode = 1;
      return;
    }
    const tooling = await loadDatabaseTooling();
    const mode = flags.session ? "session" : flags.dev ? "dev" : undefined;
    const options: InitOptions = {
      ...(mode ? { mode } : {}),
      ...(flags.schema ? { schema: flags.schema } : {}),
      ...(flags.ttl !== undefined ? { ttl: flags.ttl } : {}),
      interactive: !flags.yes && isInteractive(),
      onStep: info,
    };
    printInitReport(await tooling.runInit(tooling.createDbContext(), options));
  } catch (error) {
    fail(error);
  }
}

export const dbInitCommand = new Command("init")
  .description(
    "Set up your Lakebase dev or session branch for local development: create or reuse it, ensure an endpoint and your role, point .env at it, then set up the schema",
  )
  .addOption(
    new Option(
      "--session",
      "use this checkout's session branch, created with a TTL",
    ).conflicts("dev"),
  )
  .addOption(
    new Option(
      "--dev",
      "use your dev branch, even when .env points at a session branch",
    ),
  )
  .option(
    "--ttl <duration>",
    "TTL of a new session branch, e.g. 30m, 1h or 7d (default 7d)",
  )
  .addOption(
    new Option(
      "--schema <start>",
      "how the schema starts (default: migrate with schema.ts, introspect without)",
    ).choices(["migrate", "introspect", "clean", "none"]),
  )
  .option(
    "-y, --yes",
    "confirm --schema clean, and fail instead of prompting on an ambiguous rename",
  )
  .addHelpText(
    "after",
    `
init asks nothing. It keeps this checkout's session branch when .env points at
one, and otherwise uses your dev branch (dev-<you>-<hash>). New branches fork
the project's default branch, so they start with a copy of its rows, production
data included. init never changes the default branch, a protected branch or a
branch databricks.yml deploys to, and never edits databricks.yml.

With --schema none, init only sets up the branch and .env: the schema and its
owner stay as the fork copied them. init never hands off schema public, which
belongs to the database rather than to an app.

The project comes from LAKEBASE_PROJECT in .env (projects/<id> or <id>), else
from LAKEBASE_ENDPOINT, else from the bundle's postgres_branch variable. When
.env names neither DATABRICKS_CONFIG_PROFILE nor DATABRICKS_HOST, init adds the
one it authenticated with.

Examples:
  $ appkit db init
  $ appkit db init --session --ttl 1h --schema clean --yes`,
  )
  .action(runDbInit);
