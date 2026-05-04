import path from "node:path";
import { Command } from "commander";
import { execa } from "execa";
import {
  bullet,
  check,
  cross,
  databasePaths,
  type LakebasePoolClient,
  openLakebasePool,
  warn,
} from "./shared";

const ADVISORY_LOCK_NAME = "appkit-db-migrate";

export const migrateCommand = new Command("migrate")
  .description("Run database migrations")
  .addCommand(
    new Command("up")
      .description("Apply pending migrations")
      .option(
        "--dry-run",
        "Print the drizzle-kit invocation and pending migrations without running",
      )
      .action(async (opts: { dryRun?: boolean }) => {
        await runMigrateUp({ dryRun: Boolean(opts.dryRun) });
      }),
  )
  .addCommand(
    new Command("status")
      .description("Show migration status")
      .action(() => runDrizzle(["check"])),
  )
  .addCommand(
    new Command("reset")
      .description("Drop generated migrations metadata in development")
      .action(() => {
        if (process.env.NODE_ENV === "production") {
          console.error(cross("db migrate reset is forbidden in production."));
          process.exit(1);
        }
        return runDrizzle(["drop"]);
      }),
  );

/**
 * Run `drizzle-kit migrate` guarded by a Postgres session-level advisory lock
 * so two concurrent deploys cannot race the same migration. The lock is held
 * on the CLI's own pg connection for the lifetime of the drizzle-kit
 * subprocess; a second runner blocks on its own `pg_advisory_lock` call
 * instead of fighting drizzle-kit head-on.
 */
async function runMigrateUp(opts: { dryRun: boolean }): Promise<void> {
  const paths = databasePaths();
  const args = drizzleArgs(paths, ["migrate"]);
  console.log(bullet(`npx ${args.join(" ")}`));

  if (opts.dryRun) {
    console.log(check("Dry run: would acquire advisory lock and migrate."));
    return;
  }

  const pool = await openLakebasePool();
  if (!pool) {
    console.error(
      cross(
        "No Lakebase connection. Set LAKEBASE_ENDPOINT or PGHOST before `db migrate up`.",
      ),
    );
    process.exit(1);
    return;
  }

  let client: LakebasePoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query(
      `SELECT pg_advisory_lock(hashtext('${ADVISORY_LOCK_NAME}'))`,
    );
    console.log(bullet("Acquired migration advisory lock."));

    try {
      await execa("npx", args, {
        cwd: paths.root,
        stdio: "inherit",
        env: process.env,
      });
      console.log(check("Done."));
    } catch (error) {
      console.error(
        cross(`drizzle-kit migrate failed: ${(error as Error).message}`),
      );
      process.exit(1);
    }
  } finally {
    if (client) {
      try {
        await client.query(
          `SELECT pg_advisory_unlock(hashtext('${ADVISORY_LOCK_NAME}'))`,
        );
      } catch (error) {
        console.error(
          warn(
            `Failed to release migration advisory lock: ${(error as Error).message}`,
          ),
        );
      }
      client.release();
    }
    await pool.end();
  }
}

async function runDrizzle(command: string[]): Promise<void> {
  const paths = databasePaths();
  const args = drizzleArgs(paths, command);

  console.log(bullet(`npx ${args.join(" ")}`));
  try {
    await execa("npx", args, {
      cwd: paths.root,
      stdio: "inherit",
      env: process.env,
    });
    console.log(check("Done."));
  } catch (error) {
    console.error(
      cross(
        `drizzle-kit ${command.join(" ")} failed: ${(error as Error).message}`,
      ),
    );
    process.exit(1);
  }
}

function drizzleArgs(
  paths: ReturnType<typeof databasePaths>,
  command: string[],
): string[] {
  return [
    "drizzle-kit",
    ...command,
    "--out",
    path.relative(paths.root, paths.migrationsDir),
    "--schema",
    path.relative(paths.root, paths.schemaFile),
    "--dialect",
    "postgresql",
  ];
}
