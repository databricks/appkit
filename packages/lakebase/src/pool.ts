import pg from "pg";
import { resolveLogger } from "./logger";
import { getLakebasePgConfig } from "./pool-config";
import {
  attachPoolMetrics,
  initTelemetry,
  SpanKind,
  SpanStatusCode,
} from "./telemetry";
import type { LakebasePoolConfig } from "./types";

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
 * // Use the `name` field from the Databricks CLI output:
 * // `databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}`
 * const pool = createLakebasePool({
 *   endpoint: 'projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}',
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
  const logger = resolveLogger(userConfig.logger);

  const telemetry = initTelemetry();

  const poolConfig = getLakebasePgConfig(userConfig, telemetry, logger);

  const pool = new pg.Pool(poolConfig);

  attachPoolMetrics(pool, telemetry, logger);

  // Wrap pool.query to track query duration and create trace spans.
  // pg.Pool.query has 15+ overloads that are difficult to type-preserve,
  // so we use a loosely-typed wrapper and cast back.
  const origQuery = pool.query.bind(pool);
  const tracer = telemetry.tracer;
  pool.query = function queryWithTelemetry(
    ...args: unknown[]
  ): ReturnType<typeof pool.query> {
    const firstArg = args[0];
    const sql =
      typeof firstArg === "string"
        ? firstArg
        : (firstArg as { text?: string } | undefined)?.text;
    const metricAttrs = {
      "db.statement": sql ? sql.substring(0, 100) : "unknown",
    };

    return tracer.startActiveSpan(
      "lakebase.query",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "lakebase",
          "db.statement": sql ? sql.substring(0, 500) : "unknown",
        },
      },
      (span) => {
        const start = Date.now();

        const result = (
          origQuery as (...a: unknown[]) => Promise<unknown> | undefined
        )(...args);

        // Promise-based query: record duration and end span on completion
        if (result && typeof result.then === "function") {
          return (result as Promise<{ rowCount?: number | null }>)
            .then(
              (res) => {
                span.setAttribute("db.rows_affected", res?.rowCount ?? 0);
                span.setStatus({ code: SpanStatusCode.OK });
                return res;
              },
              (err: Error) => {
                span.recordException(err);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
              },
            )
            .finally(() => {
              telemetry.queryDuration.record(Date.now() - start, metricAttrs);
              span.end();
            }) as unknown as ReturnType<typeof pool.query>;
        }

        // Callback-based query (void return): duration is approximate
        telemetry.queryDuration.record(Date.now() - start, metricAttrs);
        span.end();
        return result as ReturnType<typeof pool.query>;
      },
    ) as ReturnType<typeof pool.query>;
  } as typeof pool.query;

  logger?.debug(
    "Created Lakebase connection pool for %s@%s/%s",
    poolConfig.user,
    poolConfig.host,
    poolConfig.database,
  );

  return pool;
}
