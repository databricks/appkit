import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  bullet,
  check,
  databasePaths,
  runCommandAction,
  warn,
  withLakebasePool,
} from "./shared";

export interface SeedOptions {
  file?: string;
  allowDdl?: boolean;
}

const DDL_PATTERN = /\b(create|alter|drop|truncate|grant|revoke)\b/i;

export const seedCommand = new Command("seed")
  .description("Run data-only dev/demo seed SQL against Lakebase")
  .option("-f, --file <path>", "SQL seed file to run")
  .option("--allow-ddl", "Allow DDL in seed SQL for local fixtures")
  .action((opts) =>
    runCommandAction(() =>
      runSeed({
        file: opts.file ? String(opts.file) : undefined,
        allowDdl: Boolean(opts.allowDdl),
      }),
    ),
  );

export async function runSeed(options: SeedOptions = {}): Promise<void> {
  const paths = databasePaths();
  const seedFile = options.file
    ? path.resolve(paths.root, options.file)
    : path.join(paths.configDir, "seed.sql");

  const sql = await readFile(seedFile, "utf8").catch(() => {
    throw new Error(
      `Seed file not found at ${path.relative(paths.root, seedFile)}. Create config/database/seed.sql or pass --file.`,
    );
  });

  assertSeedSqlAllowed(sql, { allowDdl: Boolean(options.allowDdl) });

  await withLakebasePool(async (pool) => {
    console.log(bullet(`Running ${path.relative(paths.root, seedFile)}`));
    await pool.query(sql);
    console.log(check("Seed complete."));
  });
}

export function assertSeedSqlAllowed(
  sql: string,
  options: { allowDdl?: boolean } = {},
): void {
  const uncommentedSql = stripSqlComments(sql);
  if (options.allowDdl) {
    if (DDL_PATTERN.test(uncommentedSql)) {
      console.log(
        warn(
          "--allow-ddl enabled. Seed is running DDL; keep this out of production flows.",
        ),
      );
    }
    return;
  }

  if (DDL_PATTERN.test(uncommentedSql)) {
    throw new Error(
      "Seed files are data-only by default. Move schema changes to config/database/schema.ts and run appkit db migration generate, or pass --allow-ddl for local fixtures.",
    );
  }
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ");
}
