import type { PoolClient } from "pg";

import { inTransaction } from "../migrations/apply";
import { type DbContext, withBranchPool } from "./context";

/** Run work in one transaction on the `.env` branch. */
export function runInTransaction<T>(
  ctx: DbContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withBranchPool(ctx, async (pool) => {
    const client = await pool.connect();
    let failed: Error | undefined;
    try {
      return await inTransaction(client, () => work(client));
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      // A connection whose transaction state is unknown is not reused.
      client.release(failed);
    }
  });
}
