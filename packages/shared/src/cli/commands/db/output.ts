import path from "node:path";
import process from "node:process";

import type { MigrateReport } from "@databricks/appkit/database-tooling";
import pc from "picocolors";

/** Prompts only when a human can answer them. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function relative(file: string): string {
  return path.relative(process.cwd(), file) || file;
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
