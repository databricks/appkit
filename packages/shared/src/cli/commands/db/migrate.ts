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
 * Run `drizzle-kit migrate` under a session-level advisory lock so two deploys
 * can't race. Held on the CLI's pg conn for the subprocess lifetime; a second
 * runner waits on its own `pg_advisory_lock`.
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
    // pg_try_advisory_lock + bounded retry so a wedged CI session can't block
    // follow-on deploys forever.
    const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
    const LOCK_RETRY_MS = 5_000;
    const lockDeadline = Date.now() + LOCK_TIMEOUT_MS;
    let acquired = false;
    while (!acquired) {
      const { rows } = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('${ADVISORY_LOCK_NAME}')) AS acquired`,
      );
      if (rows[0]?.acquired) {
        acquired = true;
        break;
      }
      if (Date.now() >= lockDeadline) {
        throw new Error(
          `Migration advisory lock not acquired within ${LOCK_TIMEOUT_MS / 1000}s; another deploy may be wedged.`,
        );
      }
      console.log(bullet("Migration lock held by another runner; retrying…"));
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
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
