import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import type { IntrospectReport, MigrateReport } from "./tooling-contract";

/** Prompts only when a human can answer them. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function relative(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

/** The last segment of a Lakebase resource name: projects/p/branches/dev-a → dev-a. */
function shortName(name: string): string {
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

export function printMigrateReport(report: MigrateReport): void {
  if (report.generated) {
    const count = report.generated.statements.length;
    ok(
      `Generated ${relative(report.generated.file)} (${count} statement${count === 1 ? "" : "s"})`,
    );
  } else {
    info("No schema changes since the last migration");
  }
  if (report.generated && report.breaking?.length) {
    warn(
      `${report.generated.tag} breaks instances still running the previous release, which keep serving while the new one migrates on start: ${report.breaking.join(" ")} ` +
        "Deploy code that works with both the old and the new schema first, then this change in a later deploy.",
    );
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

export function printIntrospectReport(report: IntrospectReport): void {
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
      "This branch keeps the approximated objects as they are; a database the migrations create gets what schema.ts declares.",
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
