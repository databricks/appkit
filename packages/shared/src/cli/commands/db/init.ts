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
import type {
  InitOptions,
  InitReport,
  Rebuild,
  SchemaStart,
} from "./tooling-contract";

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

function printRebuild(rebuild: Rebuild): void {
  printCleanReport(rebuild.clean);
  printMigrateReport(rebuild.migrate);
}

function printInitReport(
  report: InitReport,
  schemaFlag: SchemaStart | undefined,
): void {
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
  // Without --schema, only a branch init forked gets a rebuild.
  const rebuilt =
    start.kind === "clean" || (start.kind === "introspect" && start.rebuilt);
  if (rebuilt && schemaFlag === undefined) {
    info(
      `A branch init forked starts without the rows it copied: the app schema was rebuilt from the committed migrations. \`appkit db init --schema ${start.kind === "introspect" ? "introspect" : "migrate"}\` keeps them.`,
    );
  }
  if (start.kind === "introspect") {
    printIntrospectReport(start.introspect, {
      rebuilt: start.rebuilt !== null,
    });
    if (start.rebuilt) printRebuild(start.rebuilt);
  } else if (start.kind === "migrate") printMigrateReport(start.migrate);
  else if (start.kind === "clean") printRebuild(start);
  else info("Left the schema as it is");
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
    printInitReport(
      await tooling.runInit(tooling.createDbContext(), options),
      flags.schema,
    );
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
      "how the schema starts (default: a new branch is rebuilt from the migrations, a reused one is migrated; introspect without schema.ts)",
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
one, and otherwise uses your dev branch (dev-<you>-<hash>). A new branch forks
the project's default branch, which copies its rows, production data included.
init then rebuilds the app schema from the committed migrations (written first
by introspect when there is no schema.ts), so the new branch starts without
them; a run that stops before that finishes rebuilds on its rerun. --schema
migrate, or --schema introspect without schema.ts, keeps the copied rows. A
reused branch keeps its data: init migrates it. In schema public only your own
objects go; what other roles own stays with its rows, and init lists it. init
never changes the default branch, a protected branch or a branch databricks.yml
deploys to, and never edits databricks.yml.

With --schema none, init only sets up the branch and .env: the schema and its
owner stay as the fork copied them. init never hands off schema public, which
belongs to the database rather than to an app.

The project comes from LAKEBASE_PROJECT in .env (projects/<id> or <id>), else
from LAKEBASE_ENDPOINT, else from the bundle's postgres_branch variable. When
.env names neither DATABRICKS_CONFIG_PROFILE nor DATABRICKS_HOST, init adds the
one it authenticated with.

Examples:
  $ appkit db init
  $ appkit db init --schema migrate
  $ appkit db init --session --ttl 1h --schema clean --yes`,
  )
  .action(runDbInit);
