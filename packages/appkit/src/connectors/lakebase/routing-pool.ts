import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import type { CallerContext } from "../../context/caller-context";
import { getCallerContext } from "../../context/execution-context";

/**
 * Subset of `pg.Pool` exposed by the Lakebase plugin.
 *
 * RoutingPool does not extend EventEmitter — event listener methods
 * like `on('error', ...)` are not available. Use `query()`, `connect()`,
 * and `end()` for all pool operations.
 */
export interface LakebasePool {
  query<T extends QueryResultRow = any>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/**
 * A `pg.Pool`-like wrapper that routes queries to the appropriate pool
 * based on the current execution context.
 *
 * When called inside `runInCallerContext()` (set up by `Plugin.asUser(req)`),
 * queries route to the per-user pool returned by `resolveUserPool`.
 * Otherwise, queries route to the service-principal pool.
 *
 * This enables OBO (On-Behalf-Of) without custom `asUser()` overrides —
 * the base class sets up AsyncLocalStorage context, and the RoutingPool
 * reads it transparently.
 */
export class RoutingPool implements LakebasePool {
  constructor(
    private spPool: Pool,
    private resolveUserPool: (ctx: CallerContext) => Pool,
  ) {}

  private activePool(): Pool {
    const userCtx = getCallerContext();
    return userCtx ? this.resolveUserPool(userCtx) : this.spPool;
  }

  query<T extends QueryResultRow = any>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.activePool().query<T>(text, values);
  }

  connect(): Promise<PoolClient> {
    return this.activePool().connect();
  }

  async end(): Promise<void> {
    await this.spPool.end();
  }

  get totalCount() {
    return this.spPool.totalCount;
  }
  get idleCount() {
    return this.spPool.idleCount;
  }
  get waitingCount() {
    return this.spPool.waitingCount;
  }
}
