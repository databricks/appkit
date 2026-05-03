import { Command } from "commander";
import { migrateUp } from "./migrate";
import { generateMigration } from "./migration";
import { runSeed } from "./seed";
import { bullet, check, runCommandAction } from "./shared";
import { verifyDatabase } from "./verify";

export interface SetupDevOptions {
  name: string;
  seed?: boolean;
  force?: boolean;
  seedFile?: string;
  allowDdl?: boolean;
}

export interface SetupDevDeps {
  generateMigration?: typeof generateMigration;
  migrateUp?: typeof migrateUp;
  runSeed?: typeof runSeed;
  verifyDatabase?: typeof verifyDatabase;
}

export const setupDevCommand = new Command("setup:dev")
  .description(
    "Dev-only shortcut: generate migration, migrate, optional seed, verify",
  )
  .requiredOption("--name <name>", "Migration name for generated SQL")
  .option("--seed", "Run config/database/seed.sql after migrations")
  .option("--seed-file <path>", "Seed file to use when --seed is set")
  .option("--allow-ddl", "Allow DDL in seed SQL for local fixtures")
  .option("--force", "Allow setup:dev in CI for ephemeral test databases")
  .action((opts) =>
    runCommandAction(() =>
      setupDev({
        name: String(opts.name),
        seed: Boolean(opts.seed),
        seedFile: opts.seedFile ? String(opts.seedFile) : undefined,
        allowDdl: Boolean(opts.allowDdl),
        force: Boolean(opts.force),
      }),
    ),
  );

export async function setupDev(
  options: SetupDevOptions,
  deps: SetupDevDeps = {},
): Promise<void> {
  const commands = {
    generateMigration: deps.generateMigration ?? generateMigration,
    migrateUp: deps.migrateUp ?? migrateUp,
    runSeed: deps.runSeed ?? runSeed,
    verifyDatabase: deps.verifyDatabase ?? verifyDatabase,
  };

  assertDevSetupAllowed({ force: Boolean(options.force) });

  console.log(bullet("Generating database migration"));
  await commands.generateMigration({ name: options.name });

  console.log(bullet("Applying database migrations"));
  await commands.migrateUp();

  if (options.seed) {
    console.log(bullet("Running database seed"));
    await commands.runSeed({
      file: options.seedFile,
      allowDdl: Boolean(options.allowDdl),
    });
  }

  console.log(bullet("Verifying database schema"));
  await commands.verifyDatabase();

  console.log(check("Development database setup complete."));
}

export function assertDevSetupAllowed(options: { force?: boolean } = {}): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("appkit db setup:dev is forbidden in production.");
  }

  if (process.env.CI === "true" && !options.force) {
    throw new Error(
      "appkit db setup:dev is intended for local development and refuses CI by default. Use explicit migration commands in CI, or pass --force for an intentional ephemeral test database.",
    );
  }
}
