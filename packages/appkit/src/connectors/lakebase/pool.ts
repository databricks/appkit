import pg from "pg";
import { createLogger } from "../../logging/logger";
import { getLakebasePgConfig } from "./pool-config";
import { attachPoolMetrics, initTelemetry } from "./telemetry";
import type { LakebasePoolConfig } from "./types";

const logger = createLogger("connectors:lakebase:pool");

/**
 * Create a PostgreSQL connection pool with automatic OAuth token refresh for Lakebase.
 *
 * This function returns a standard `pg.Pool` instance configured with a password callback
 * that automatically fetches and caches OAuth tokens from Databricks. The returned pool
 * works with any ORM or library that accepts a `pg.Pool` (Drizzle, Prisma, TypeORM, etc.).
 *
 * @param config - Configuration options (optional, reads from environment if not provided)
 * @returns Standard pg.Pool instance with OAuth token refresh
 *
 * @see https://docs.databricks.com/aws/en/oltp/projects/authentication
 *
 * @example Using environment variables
 * ```typescript
 * // Set: PGHOST, PGDATABASE, LAKEBASE_ENDPOINT
 * const pool = createLakebasePool();
 * const result = await pool.query('SELECT * FROM users');
 * ```
 *
 * @example With explicit configuration
 * ```typescript
 * // Format: projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}
 * // Note: Use actual IDs from Databricks (project-id is a UUID)
 * const pool = createLakebasePool({
 *   endpoint: 'projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0',
 *   host: 'ep-abc.databricks.com',
 *   database: 'databricks_postgres',
 *   user: 'service-principal-id'
 * });
 * ```
 *
 * @example With Drizzle ORM
 * ```typescript
 * import { drizzle } from 'drizzle-orm/node-postgres';
 * const pool = createLakebasePool();
 * const db = drizzle({ client: pool });
 * ```
 *
 * @example With Prisma
 * ```typescript
 * import { PrismaPg } from '@prisma/adapter-pg';
 * const pool = createLakebasePool();
 * const adapter = new PrismaPg(pool);
 * const prisma = new PrismaClient({ adapter });
 * ```
 */
export function createLakebasePool(
  config?: Partial<LakebasePoolConfig>,
): pg.Pool {
  const userConfig = config ?? {};

  // Initialize telemetry once and thread it through to avoid duplicate instruments
  const telemetry = initTelemetry(userConfig);

  // Get complete pool config (connection + pool settings)
  const poolConfig = getLakebasePgConfig(userConfig, telemetry);

  // Create standard pg.Pool with the config
  const pool = new pg.Pool(poolConfig);

  // Attach pool-level telemetry metrics (gauges, error counter, and error logging)
  attachPoolMetrics(pool, telemetry);

  // Wrap pool.query to track query duration.
  // pg.Pool.query has 15+ overloads that are difficult to type-preserve,
  // so we use a loosely-typed wrapper and cast back.
  const origQuery = pool.query.bind(pool);
  pool.query = function queryWithMetrics(
    ...args: unknown[]
  ): ReturnType<typeof pool.query> {
    const start = Date.now();
    const firstArg = args[0];
    const sql =
      typeof firstArg === "string"
        ? firstArg
        : (firstArg as { text?: string } | undefined)?.text;
    const attrs = {
      "db.statement": sql ? sql.substring(0, 100) : "unknown",
    };

    const result = (
      origQuery as (...a: unknown[]) => Promise<unknown> | undefined
    )(...args);

    // Promise-based query: record duration on completion
    if (result && typeof result.finally === "function") {
      return result.finally(() => {
        telemetry.queryDuration.record(Date.now() - start, attrs);
      }) as unknown as ReturnType<typeof pool.query>;
    }

    // Callback-based query (void return): duration is approximate
    telemetry.queryDuration.record(Date.now() - start, attrs);
    return result as ReturnType<typeof pool.query>;
  } as typeof pool.query;

  logger.info(
    "Created Lakebase connection pool for %s@%s/%s",
    poolConfig.user,
    poolConfig.host,
    poolConfig.database,
  );

  return pool;
}
