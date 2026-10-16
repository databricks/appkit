import { loadDefaultDatabaseSchema } from "../../plugins/database/load-schema";
import { cleanStatements } from "../migrations/ownership";
import { runInTransaction } from "./branch-sql";
import type { DbContext } from "./context";
import { assertAppkitBranch } from "./guard";
import { requireSchemaFile } from "./migrate";

interface CleanReport {
  readonly branch: string;
  readonly schemaName: string;
}

/**
 * `appkit db clean`: remove every app-schema object, including the migration
 * journal, on an AppKit dev or session branch. Refuses any other branch
 * before connecting.
 */
export async function runClean(ctx: DbContext): Promise<CleanReport> {
  requireSchemaFile(ctx.root, "clean");
  const branch = await assertAppkitBranch(ctx, "clean");
  const schema = await loadDefaultDatabaseSchema(ctx.root, {
    showImportError: true,
  });
  await runInTransaction(ctx, cleanStatements(schema.$schemaName));
  return { branch: branch.name, schemaName: schema.$schemaName };
}
