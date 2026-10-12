import type {
  BranchMode,
  DbContext,
  InitChoices,
  InitReport,
  SchemaStart,
} from "@databricks/appkit/database-tooling";
import { Command, Option } from "commander";

import {
  fail,
  info,
  isInteractive,
  ok,
  printIntrospectReport,
  printMigrateReport,
  shortName,
} from "./output";

type Tooling = typeof import("@databricks/appkit/database-tooling");

export interface InitFlags {
  readonly new?: "dev" | "session";
  readonly schema?: SchemaStart | "none";
  readonly yes?: boolean;
}

/** null: the user cancelled a prompt. */
type Choice<T> = T | null;

async function promptMode(): Promise<Choice<BranchMode>> {
  const { isCancel, select } = await import("@clack/prompts");
  const mode = await select<BranchMode>({
    message: "Which Lakebase branch should local development use?",
    options: [
      {
        value: "dev",
        label: "New per-developer branch",
        hint: "dev-<you>-…, forked from the default branch, reused on re-runs",
      },
      {
        value: "session",
        label: "New per-session branch",
        hint: "session-…, for this checkout, expires after 7 days",
      },
    ],
    initialValue: "dev",
  });
  return isCancel(mode) ? null : mode;
}

const START_LABELS: Record<SchemaStart, string> = {
  migrate: "Apply migrations",
  introspect: "Introspect",
  clean: "Start clean",
};

function startHint(start: SchemaStart, hasSchema: boolean): string {
  if (start === "migrate") return "schema.ts → migration → branch";
  if (start === "clean") {
    return "drop the app schema, then apply committed migrations";
  }
  return hasSchema
    ? "write schema.ts from the tables the branch copied"
    : "there is no schema.ts yet: write it from the branch's tables";
}

/** Only the starts that can run here (schemaStartsFor), the default first, then "leave". */
async function promptSchemaStart(
  tooling: Tooling,
  hasSchema: boolean,
): Promise<Choice<SchemaStart | "none">> {
  const { isCancel, select } = await import("@clack/prompts");
  const starts = tooling.schemaStartsFor(hasSchema);
  const options: {
    value: SchemaStart | "none";
    label: string;
    hint?: string;
  }[] = [
    ...starts.map((value) => ({
      value,
      label: START_LABELS[value],
      hint: startHint(value, hasSchema),
    })),
    { value: "none", label: "Leave the schema as it is" },
  ];
  const start = await select<SchemaStart | "none">({
    message: "How should the branch's schema start?",
    options,
    initialValue: tooling.defaultSchemaStart(hasSchema),
  });
  return isCancel(start) ? null : start;
}

/**
 * Flags first, then the mode .env's branch implies (your dev or this
 * checkout's session branch), then prompts, then defaults. With `--yes` or
 * without a TTY nothing is prompted: mode falls back to "dev" and the schema
 * start to defaultSchemaStart (migrate with schema.ts, introspect without).
 * Returns null when a prompt is cancelled.
 */
export async function resolveInitChoices(
  tooling: Tooling,
  ctx: DbContext,
  flags: InitFlags,
  interactive: boolean,
): Promise<InitChoices | null> {
  const defaults = await tooling.resolveInitDefaults(ctx);
  let mode: BranchMode | undefined = flags.new ?? defaults.mode ?? undefined;
  if (!mode) {
    if (interactive) {
      const picked = await promptMode();
      if (!picked) return null;
      mode = picked;
    } else {
      mode = "dev";
    }
  }

  let start: SchemaStart | "none" | undefined = flags.schema;
  if (!start) {
    if (interactive) {
      const picked = await promptSchemaStart(tooling, defaults.hasSchema);
      if (!picked) return null;
      start = picked;
    } else {
      start = tooling.defaultSchemaStart(defaults.hasSchema);
    }
  }
  return { mode, schemaStart: start === "none" ? null : start };
}

function printInitReport(report: InitReport): void {
  const branch = shortName(report.branch);
  ok(
    report.created
      ? `Branch ${branch} (created from ${shortName(report.sourceBranch ?? "the default branch")})`
      : `Branch ${branch} (reused)`,
  );
  ok(
    `Endpoint ${shortName(report.endpoint)}${report.endpointCreated ? " (created)" : ""} — ${report.host}`,
  );
  const role = {
    created: "created",
    updated: "added to DATABRICKS_SUPERUSER",
    kept: "DATABRICKS_SUPERUSER",
  }[report.role.action];
  ok(`Role ${report.user} (${role})`);
  if (report.handedOff.length > 0) {
    ok(`Handed the objects owned by ${report.handedOff.join(", ")} to you`);
  }
  ok(`Pointed .env at ${branch} (database ${report.database})`);
  if (report.cleaned) ok("Removed every object in the app schema");
  if (report.introspect) printIntrospectReport(report.introspect);
  else if (report.schema) printMigrateReport(report.schema);
  else info("Left the schema as it is");
}

async function runDbInit(flags: InitFlags): Promise<void> {
  try {
    const tooling = await import("@databricks/appkit/database-tooling");
    const ctx = tooling.createDbContext();
    const interactive = !flags.yes && isInteractive();
    const choices = await resolveInitChoices(tooling, ctx, flags, interactive);
    if (!choices) {
      info("Cancelled");
      return;
    }
    printInitReport(await tooling.runInit(ctx, choices, { interactive }));
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
      "--new <mode>",
      "create or reuse a per-developer or per-session branch",
    ).choices(["dev", "session"]),
  )
  .addOption(
    new Option("--schema <start>", "how the branch's schema starts").choices([
      "migrate",
      "introspect",
      "clean",
      "none",
    ]),
  )
  .option(
    "-y, --yes",
    "no prompts: mode from --new, then from the branch .env points at, then dev; schema from --schema, then migrate with schema.ts, introspect without",
  )
  .addHelpText(
    "after",
    `
Without --new, init keeps your dev branch or this checkout's session branch when
.env already points at one, and otherwise asks (dev without prompts). New
branches fork the project's default branch. init never changes the default
branch, a protected branch or a branch databricks.yml deploys to, and never edits
databricks.yml. The project comes from LAKEBASE_PROJECT in .env (projects/<id>
or <id>), else from LAKEBASE_ENDPOINT, else from the bundle's postgres_branch
variable. A fresh checkout needs only DATABRICKS_CONFIG_PROFILE and
LAKEBASE_PROJECT.

Examples:
  $ appkit db init
  $ appkit db init --new dev --yes
  $ appkit db init --new session --schema clean --yes`,
  )
  .action(runDbInit);
