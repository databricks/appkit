import { getUsernameSync, mapSslConfig, parseConfig } from "./config";
import { createPasswordProvider } from "./password-provider";
import type { FetchCredential, LakebaseAuthConfig, SslConfig } from "./types";

/**
 * A driver-agnostic Postgres connection config with an OAuth password callback.
 *
 * The connection fields are compatible with `pg` (and, by spreading, with
 * `postgres.js` and `Bun.SQL` — note those use `username`/`hostname`/`tls`,
 * so map the fields accordingly). `dispose` stops any background token refresh
 * and should be called when the connection/pool is closed; it is a no-op for
 * native-password and lazy-refresh configs.
 */
export interface PgConfig {
  host: string;
  port: number;
  user: string;
  database: string;
  password: string | (() => string | Promise<string>);
  ssl: SslConfig;
  /** Stop background token refresh (idempotent). Call on shutdown. */
  dispose: () => void;
}

/** Options accepted by {@link getPgConfig}. */
export interface GetPgConfigOptions extends Partial<LakebaseAuthConfig> {
  /**
   * Custom credential fetcher (e.g. telemetry-wrapped). When omitted, the
   * default SDK-based fetcher is used with `endpoint` + `workspaceClient`.
   */
  fetchCredential?: FetchCredential;
}

/**
 * Build a Postgres connection config for Lakebase with OAuth token refresh.
 *
 * Reads from the provided config and falls back to environment variables
 * (`PGHOST`, `PGDATABASE`, `LAKEBASE_ENDPOINT`, `PGUSER`/`DATABRICKS_CLIENT_ID`,
 * `PGPORT`, `PGSSLMODE`). When a native `password` is supplied, OAuth is skipped.
 *
 * @example pg
 * ```typescript
 * import pg from "pg";
 * import { getPgConfig } from "@databricks/lakebase-auth";
 *
 * const { dispose, ...config } = getPgConfig();
 * const pool = new pg.Pool(config);
 * // on shutdown: await pool.end(); dispose();
 * ```
 *
 * @example postgres.js
 * ```typescript
 * import postgres from "postgres";
 * import { getPgConfig } from "@databricks/lakebase-auth";
 *
 * const { host, port, user, database, password, ssl } = getPgConfig();
 * const sql = postgres({ host, port, username: user, database, password, ssl });
 * ```
 *
 * @example Bun.SQL
 * ```typescript
 * import { getPgConfig } from "@databricks/lakebase-auth";
 *
 * const { host, port, user, database, password } = getPgConfig();
 * const sql = new Bun.SQL({ hostname: host, port, username: user, database, password, tls: true });
 * ```
 */
export function getPgConfig(config?: GetPgConfigOptions): PgConfig {
  const userConfig = config ?? {};
  const parsed = parseConfig(userConfig);
  const user = getUsernameSync(userConfig);
  const ssl = parsed.ssl ?? mapSslConfig(parsed.sslMode);

  // Native password authentication: no OAuth provider needed.
  if (userConfig.password !== undefined) {
    return {
      host: parsed.host,
      port: parsed.port,
      user,
      database: parsed.database,
      password: userConfig.password,
      ssl,
      dispose: () => {},
    };
  }

  const provider = createPasswordProvider({
    fetchCredential: userConfig.fetchCredential,
    // endpoint is guaranteed here -- parseConfig() throws if neither
    // endpoint nor password is provided.
    endpoint: parsed.endpoint,
    workspaceClient: userConfig.workspaceClient,
    userConfig,
    claims: userConfig.claims,
    mode: userConfig.refresh,
    earlyRefreshMs: userConfig.earlyRefreshMs,
    retry: userConfig.retry,
    onLog: userConfig.onLog,
  });

  return {
    host: parsed.host,
    port: parsed.port,
    user,
    database: parsed.database,
    password: provider.password,
    ssl,
    dispose: provider.dispose,
  };
}
