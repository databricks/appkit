import fs from "node:fs";
import path from "node:path";

import { loadDefaultDatabaseSchema } from "../../plugins/database/load-schema";
import { quoteIdentifier } from "../migrations/apply";
import { DEFAULT_SCHEMA_NAME } from "../schema-builder/define-schema";
import { runInTransaction } from "./branch-sql";
import type { DbContext } from "./context";
import { writableEnvBranch } from "./guard";
import { hasSchemaFile } from "./migrate";

export const SEED_FILE = "config/database/seed.sql";

interface SeedReport {
  readonly branch: string;
  readonly file: string;
}

/**
 * `appkit db seed`: run config/database/seed.sql in one transaction on your
 * dev or session branch, with the app schema first on the search_path so
 * unqualified names resolve to it. Refuses any other branch before connecting.
 */
export async function runSeed(ctx: DbContext): Promise<SeedReport> {
  const file = path.join(ctx.root, SEED_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No seed file at ${SEED_FILE}. Create it with the SQL to run.`,
    );
  }
  const branch = await writableEnvBranch(ctx, "seed");
  const schemaName = hasSchemaFile(ctx.root)
    ? (await loadDefaultDatabaseSchema(ctx.root, { showImportError: true }))
        .$schemaName
    : DEFAULT_SCHEMA_NAME;
  const searchPath =
    schemaName === "public"
      ? "public"
      : `${quoteIdentifier(schemaName)}, public`;
  const sql = fs.readFileSync(file, "utf-8");
  await runInTransaction(ctx, async (client) => {
    await client.query(`SET LOCAL search_path TO ${searchPath}`);
    // One simple-protocol query: the file may hold several statements.
    await client.query(sql);
  });
  return { branch: branch.name, file };
}
