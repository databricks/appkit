import { type DbContext, openBranchPool } from "./context";

/** Run statements on the `.env` branch in one transaction, then end the pool. */
export async function runInTransaction(
  ctx: DbContext,
  statements: readonly string[],
): Promise<void> {
  const pool = await openBranchPool(ctx);
  if (!pool) {
    throw new Error(
      "No branch configured (PGHOST, PGDATABASE, LAKEBASE_ENDPOINT) — run `appkit db init`.",
    );
  }
  try {
    const client = await pool.connect();
    let failed: unknown;
    try {
      await client.query("BEGIN");
      for (const statement of statements) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      failed = error;
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      // A connection whose transaction state is unknown is not reused.
      client.release(failed instanceof Error ? failed : undefined);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}
