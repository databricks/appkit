import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import type {
  CleanReport,
  DeployVerifyReport,
  IntrospectReport,
  LocalVerifyReport,
  MigrateReport,
  VerifyReport,
} from "./tooling-contract";

/** Prompts only when a human can answer them. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function relative(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

/** The last segment of a Lakebase resource name: projects/p/branches/dev-a → dev-a. */
export function shortName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

export const ok = (message: string) =>
  console.log(`${pc.green("✔")} ${message}`);
export const info = (message: string) =>
  console.log(`${pc.dim("•")} ${message}`);
export const warn = (message: string) =>
  console.log(`${pc.yellow("!")} ${message}`);

/** Innermost message: drizzle wraps the driver error, whose text names the failing object. */
function rootCause(error: unknown): string | undefined {
  let current = (error as { cause?: unknown } | undefined)?.cause;
  let message: string | undefined;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    message = current.message;
    current = (current as { cause?: unknown }).cause;
  }
  return message;
}

/** Print the error and its root cause, and fail the process. */
export function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${pc.red("✖")} ${message}`);
  const cause = rootCause(error);
  if (cause && cause !== message && !message.includes(cause))
    console.error(`  ${cause}`);
  process.exitCode = 1;
}

/** Statements of a written migration that break instances still running the previous release. */
export function warnBreaking(tag: string, breaking: readonly string[]): void {
  if (breaking.length === 0) return;
  warn(
    `${tag} breaks instances still running the previous release, which keep serving while the new one migrates on start: ${breaking.join(" ")} ` +
      "Deploy code that works with both the old and the new schema first, then this change in a later deploy.",
  );
}

export function printMigrateReport(report: MigrateReport): void {
  if (report.generated) {
    const count = report.generated.statements.length;
    ok(
      `Generated ${relative(report.generated.file)} (${count} statement${count === 1 ? "" : "s"})`,
    );
    warnBreaking(report.generated.tag, report.breaking ?? []);
  } else {
    info("No schema changes since the last migration");
  }

  if (report.adopted?.length) {
    ok(
      `Adopted ${report.adopted.join(", ")}: its tables already existed, so it was recorded without running`,
    );
  }
  if (report.applied.length > 0) {
    ok(`Applied ${report.applied.join(", ")} to the .env branch`);
  } else if (report.notApplied) {
    warn(`Not applied: ${report.notApplied}`);
  } else if (!report.adopted?.length) {
    info("The .env branch is up to date");
  }

  ok(`Generated ${relative(report.typesFile)}`);
}

export function printCleanReport(report: CleanReport): void {
  ok(
    report.schemaName === "public"
      ? `Removed your objects in schema public on ${shortName(report.branch)}`
      : `Dropped schema ${report.schemaName} on ${shortName(report.branch)}`,
  );
  if (report.dependents.length > 0) {
    warn(
      `Also removed, because they depended on it: ${report.dependents.join(", ")}`,
    );
  }
  if (report.kept.length > 0) {
    warn(
      `Kept in schema public, with their rows, because other roles own them: ${report.kept.join(", ")}`,
    );
  }
}

const REBUILD =
  "`appkit db clean` and then `appkit db migrate` rebuild the branch from this checkout's migrations, in order";

/** The one next step for a failed local verify, most fundamental gap first. */
function localVerifyHint(report: LocalVerifyReport): string {
  // Tables left in public: migrating would create empty copies in the app schema.
  if (report.schemaAdvice) return report.schemaAdvice;
  if (report.editedMigrations.length > 0) {
    return "Restore the edited migrations from version control, and put the change in a new migration.";
  }
  if (report.unknownMigrations > 0) {
    return `${REBUILD}. If the branch ran migrations you have not pulled yet, pull them instead.`;
  }
  // The same guidance the deployed app's MigrationHistoryError gives: the
  // history itself is wrong, so rebuilding the local branch would not fix it.
  if (report.strandedMigrations.length > 0) {
    const its = report.strandedMigrations.length === 1 ? "its" : "their";
    return `Delete ${its} .sql file, snapshot and journal entry, then run \`appkit db migrate\` to generate the migration again from schema.ts, after the recorded ones.`;
  }
  // Pending migrations explain the gap; without them, schema.ts changed or the branch was edited.
  return report.pendingMigrations.length > 0
    ? "Run `appkit db migrate` to apply the pending migrations."
    : "If you changed schema.ts, run `appkit db migrate`; if the branch was changed by hand, `appkit db clean` and then `appkit db migrate` rebuild it from the migrations.";
}

function printLocalVerifyReport(report: LocalVerifyReport): void {
  const branch = shortName(report.branch);
  if (report.ok) {
    ok(
      `${branch} has every table and column config/database/schema.ts declares, and every committed migration`,
    );
    return;
  }
  for (const problem of report.schemaProblems) warn(`Schema: ${problem}`);
  if (report.pendingMigrations.length > 0) {
    warn(`Pending migrations: ${report.pendingMigrations.join(", ")}`);
  }
  for (const tag of report.strandedMigrations) {
    warn(
      `Never runs: ${tag}: it is older than a migration the branch already ran (merged out of order), and the deployed app refuses to start on that history`,
    );
  }
  for (const tag of report.editedMigrations) {
    warn(
      `Never runs: ${tag}: it changed after the branch ran it, and a branch that ran it keeps the old version`,
    );
  }
  if (report.unknownMigrations > 0) {
    const one = report.unknownMigrations === 1;
    warn(
      `Not committed: the branch ran ${report.unknownMigrations} migration${one ? "" : "s"} this checkout does not have, for example from another git branch`,
    );
  }
  console.error(
    `${pc.red("✖")} ${branch} does not match config/database/schema.ts and the committed migrations. ${localVerifyHint(report)}`,
  );
}

function printDeployVerifyReport(report: DeployVerifyReport): void {
  const where = `target ${report.target}${report.host ? ` on ${report.host}` : ""}`;
  const app = report.app ? `app ${report.app}` : "The deployed app";
  const branch = shortName(report.branch);
  if (report.ok) {
    ok(
      `${app} (${where}) is running, bound to ${branch} with CAN_CONNECT_AND_CREATE, and its service principal has a role there`,
    );
    if (report.migrations?.evidence === "verified") {
      ok(
        "Its deployed source has every committed migration, with the same journal entry and SQL",
      );
    }
    return;
  }
  for (const problem of report.problems) warn(problem);
  console.error(
    `${pc.red("✖")} ${app} (${where}) cannot use ${branch} yet. Fix the above, then run \`appkit db verify --deployed -t ${report.target}\` again.`,
  );
}

export function printVerifyReport(report: VerifyReport): void {
  if (report.kind === "local") printLocalVerifyReport(report);
  else printDeployVerifyReport(report);
}

export function printIntrospectReport(
  report: IntrospectReport,
  options: { rebuilt?: boolean } = {},
): void {
  const count = report.tables.length;
  ok(
    `Wrote ${relative(report.schemaFile)} from schema ${report.schemaName} on ${shortName(report.branch)} (${count} table${count === 1 ? "" : "s"})${report.backupFile ? `; the previous file is ${relative(report.backupFile)}` : ""}`,
  );
  for (const skip of report.skipped) {
    warn(
      `Skipped ${skip.column ? `${skip.table}.${skip.column}` : `table ${skip.table}`}: ${skip.reason}`,
    );
  }
  for (const warning of report.warnings) {
    console.log(`${pc.bold(pc.red("!"))} ${pc.bold(warning)}`);
  }
  for (const difference of report.approximated) {
    info(`Approximated ${difference}`);
  }
  if (report.approximated.length > 0) {
    info(
      options.rebuilt
        ? "The rebuild gave this branch what schema.ts declares, as a database the migrations create gets."
        : "This branch keeps the approximated objects as they are; a database the migrations create gets what schema.ts declares.",
    );
  }
  if (report.migration) {
    const statements = report.migration.statements.length;
    ok(
      `Generated ${relative(report.migration.file)} (${statements} statement${statements === 1 ? "" : "s"})`,
    );
  } else {
    info(
      report.tables.length === 0
        ? "No migration needed: schema.ts has no tables"
        : "No migration needed: the migrations already describe this schema",
    );
  }
  if (report.recorded.length > 0) {
    ok(
      `Recorded ${report.recorded.join(", ")} as applied on ${shortName(report.branch)}: the branch already has ${report.recorded.length === 1 ? "what it describes" : "what they describe"}`,
    );
  }
  ok(`Generated ${relative(report.typesFile)}`);
}
