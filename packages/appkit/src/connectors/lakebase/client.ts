import { randomUUID } from "node:crypto";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { ApiClient, Config } from "@databricks/sdk-experimental";
import pg from "pg";
import {
  type Counter,
  type Histogram,
  type ILogger,
  LoggerManager,
  SpanStatusCode,
} from "@/observability";
import { deepMerge } from "../../utils";
import { lakebaseDefaults } from "./defaults";
import type {
  LakebaseConfig,
  LakebaseConnectionConfig,
  LakebaseCredentials,
} from "./types";

/**
 * Enterprise-grade connector for Databricks Lakebase
 * @example Simplest - everything from env/context
 * ```typescript
 * const connector = new LakebaseConnector();
 * await connector.query('SELECT * FROM users');
 * ```
 *
 * @example With explicit connection string
 * ```typescript
 * const connector = new LakebaseConnector({
 *   connectionString: 'postgresql://...'
 * });
 * ```
 */
export class LakebaseConnector {
  private readonly name: string = "lakebase";
  private readonly CACHE_BUFFER_MS = 2 * 60 * 1000;
  private readonly config: LakebaseConfig;
  private readonly connectionConfig: LakebaseConnectionConfig;
  private pool: pg.Pool | null = null;
  private credentials: LakebaseCredentials | null = null;

  // telemetry
  private readonly logger: ILogger;
  private readonly metrics: {
    queryCount: Counter;
    queryDuration: Histogram;
  };

  constructor(userConfig?: Partial<LakebaseConfig>) {
    this.config = deepMerge(lakebaseDefaults, userConfig);
    this.connectionConfig = this.parseConnectionConfig();

    this.logger = LoggerManager.getLogger(
      this.name,
      this.config?.observability,
    );
    this.metrics = {
      queryCount: this.logger.counter("query.count", {
        description: "Total number of queries executed",
        unit: "1",
      }),
      queryDuration: this.logger.histogram("query.duration", {
        description: "Duration of queries executed",
        unit: "ms",
      }),
    };

    // validate configuration
    if (this.config.maxPoolSize < 1) {
      throw new Error("maxPoolSize must be at least 1");
    }

    this.logger.debug("Lakebase connector initialized", {
      config: this.config,
      database: this.connectionConfig.database,
      maxPoolSize: this.config.maxPoolSize,
    });
  }

  /**
   * Execute a SQL query
   *
   * @example
   * ```typescript
   * const users = await connector.query('SELECT * FROM users');
   * const user = await connector.query('SELECT * FROM users WHERE id = $1', [123]);
   * ```
   */
  async query<T extends pg.QueryResultRow>(
    sql: string,
    params?: any[],
    retryCount: number = 0,
  ): Promise<pg.QueryResult<T>> {
    const startTime = Date.now();

    this.logger.info("Executing query", {
      statement: sql.substring(0, 500),
      has_params: !!params,
      retry_count: retryCount,
    });

    return this.logger.span("query", async (span) => {
      span.setAttribute("db.system", "lakebase");
      span.setAttribute("db.statement", sql.substring(0, 500));
      span.setAttribute("db.retry_count", retryCount);

      try {
        const pool = await this.getPool();
        const result = await pool.query<T>(sql, params);
        const rowAffected = result.rowCount ?? 0;
        const duration = Date.now() - startTime;

        span.setAttribute("db.rows_affected", rowAffected);
        span.setStatus({ code: SpanStatusCode.OK });

        this.logger.info("Query completed", {
          rows_affected: rowAffected,
          query_duration_ms: duration,
        });

        return result;
      } catch (error) {
        // retry on auth failure
        if (this.isAuthError(error)) {
          this.logger.warn("Authentication error, retrying");
          span.addEvent("auth_error_retry");

          await this.rotateCredentials();

          const newPool = await this.getPool();
          const result = await newPool.query<T>(sql, params);
          const rowsAffected = result.rowCount ?? 0;

          const duration = Date.now() - startTime;

          span.setAttribute("db.rows_affected", rowsAffected);
          span.setStatus({ code: SpanStatusCode.OK });

          this.logger.info(
            "Query executed successfully after authentication error",
            {
              rows_affected: rowsAffected,
              query_duration_ms: duration,
            },
          );

          return result;
        }

        // retry on transient errors, but only once
        if (this.isTransientError(error) && retryCount < 1) {
          this.logger.warn("Transient error, retrying", {
            error_code: (error as any).code,
          });
          span.addEvent("transient_error_retry");
          await new Promise((resolve) => setTimeout(resolve, 100));
          return await this.query<T>(sql, params, retryCount + 1);
        }

        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });

        this.logger.error("Query failed", error as Error);

        throw error;
      } finally {
        const duration = Date.now() - startTime;
        this.metrics.queryCount.add(1);
        this.metrics.queryDuration.record(duration);

        span.end();
      }
    });
  }

  /**
   * Execute a transaction
   *
   * COMMIT and ROLLBACK are automatically managed by the transaction function.
   *
   * @param callback - Callback function to execute within the transaction context
   * @example
   * ```typescript
   * await connector.transaction(async (client) => {
   *   await client.query('INSERT INTO accounts (name) VALUES ($1)', ['Alice']);
   *   await client.query('INSERT INTO logs (action) VALUES ($1)', ['Created Alice']);
   * });
   * ```
   */
  async transaction<T>(
    callback: (client: pg.PoolClient) => Promise<T>,
    retryCount: number = 0,
  ): Promise<T> {
    const startTime = Date.now();
    this.logger.info("Executing transaction", {
      retry_count: retryCount,
    });

    return this.logger.span("transaction", async (span) => {
      span.setAttribute("db.system", "lakebase");
      span.setAttribute("db.retry_count", retryCount);

      const pool = await this.getPool();
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        this.logger.debug("Transaction began");
        const result = await callback(client);
        await client.query("COMMIT");
        span.setStatus({ code: SpanStatusCode.OK });

        const duration = Date.now() - startTime;

        this.logger.info("Transaction committed", {
          transaction_duration_ms: duration,
          transaction_status: "committed",
        });

        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
          this.logger.debug("Transaction ROLLBACK");
        } catch {}
        // retry on auth failure
        if (this.isAuthError(error)) {
          this.logger.warn("Authentication error in transaction, retrying");
          span.addEvent("auth_error_retry");
          client.release();
          await this.rotateCredentials();
          const newPool = await this.getPool();
          const retryClient = await newPool.connect();
          try {
            await client.query("BEGIN");
            const result = await callback(retryClient);
            await client.query("COMMIT");
            span.setStatus({ code: SpanStatusCode.OK });

            const duration = Date.now() - startTime;

            this.logger.info(
              "Transaction committed after authentication error",
              {
                duration_ms: duration,
              },
            );

            return result;
          } catch (retryError) {
            try {
              await retryClient.query("ROLLBACK");
            } catch {}
            throw retryError;
          } finally {
            retryClient.release();
          }
        }

        // retry on transient errors, but only once
        if (this.isTransientError(error) && retryCount < 1) {
          this.logger.warn("Transient error in transaction, retrying");
          span.addEvent("transaction_error_retry");
          client.release();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return await this.transaction<T>(callback, retryCount + 1);
        }
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });

        this.logger.error("Transaction failed", error as Error);

        throw error;
      } finally {
        client.release();
        const duration = Date.now() - startTime;
        this.metrics.queryCount.add(1);
        this.metrics.queryDuration.record(duration);
        span.end();
      }
    });
  }

  /** Check if database connection is healthy */
  async healthCheck(): Promise<boolean> {
    return this.logger.span("healthCheck", async (span) => {
      try {
        const result = await this.query<{ result: number }>(
          "SELECT 1 as result",
        );
        const healthy = result.rows[0]?.result === 1;
        span.setAttribute("db.healthy", healthy);
        span.setStatus({ code: SpanStatusCode.OK });
        return healthy;
      } catch {
        span.setAttribute("db.healthy", false);
        span.setStatus({ code: SpanStatusCode.ERROR });
        return false;
      } finally {
        span.end();
      }
    });
  }

  /** Close connection pool (call on shutdown) */
  async close(): Promise<void> {
    if (this.pool) {
      this.logger.debug("Closing connection pool");
      await this.pool.end().catch((error: unknown) => {
        this.logger.error("Error closing connection pool:", error as Error);
      });
      this.pool = null;
    }
    this.credentials = null;

    this.logger.debug("Connection pool closed");
  }

  /** Setup graceful shutdown to close connection pools */
  shutdown(): void {
    process.on("SIGTERM", () => this.close());
    process.on("SIGINT", () => this.close());
    this.close();
  }

  /** Get Databricks workspace client - from config or execution context */
  private getWorkspaceClient(): WorkspaceClient {
    if (this.config.workspaceClient) {
      return this.config.workspaceClient;
    }

    try {
      const { getWorkspaceClient: getClient } = require("../../context");
      const client = getClient();

      // cache it for subsequent calls
      this.config.workspaceClient = client;
      return client;
    } catch (_error) {
      throw new Error(
        "Databricks workspace client not available. Either pass it in config or ensure ServiceContext is initialized.",
      );
    }
  }

  /** Get or create connection pool */
  private async getPool(): Promise<pg.Pool> {
    if (!this.connectionConfig) {
      throw new Error(
        "Lakebase connection not configured. " +
          "Set PGHOST, PGDATABASE, PGAPPNAME env vars, provide a connectionString, or pass explicit config.",
      );
    }

    if (!this.pool) {
      this.logger.debug("Creating new connection pool");
      const creds = await this.getCredentials();
      this.pool = this.createPool(creds);
    }
    return this.pool;
  }

  /** Create PostgreSQL pool */
  private createPool(credentials: {
    username: string;
    password: string;
  }): pg.Pool {
    const { host, database, port, sslMode } = this.connectionConfig;

    const pool = new pg.Pool({
      host,
      port,
      database,
      user: credentials.username,
      password: credentials.password,
      max: this.config.maxPoolSize,
      idleTimeoutMillis: this.config.idleTimeoutMs,
      connectionTimeoutMillis: this.config.connectionTimeoutMs,
      ssl: sslMode === "require" ? { rejectUnauthorized: true } : false,
    });

    pool.on("error", (error: Error & { code?: string }) => {
      this.logger.error("Connection pool error:", error as Error);
    });
    this.logger.debug("Connection pool created");

    return pool;
  }

  /** Get or fetch credentials with caching */
  private async getCredentials(): Promise<{
    username: string;
    password: string;
  }> {
    const now = Date.now();

    // return cached if still valid
    if (
      this.credentials &&
      now < this.credentials.expiresAt - this.CACHE_BUFFER_MS
    ) {
      this.logger.debug("Using cached credentials");
      return this.credentials;
    }

    this.logger.debug("Fetching new credentials");

    // fetch new credentials
    const username = await this.fetchUsername();
    const { token, expiresAt } = await this.fetchPassword();

    this.credentials = {
      username,
      password: token,
      expiresAt,
    };

    this.logger.debug("New credentials fetched");

    return { username, password: token };
  }

  /** Rotate credentials and recreate pool */
  private async rotateCredentials(): Promise<void> {
    this.logger.debug("Rotating credentials");
    // clear cached credentials
    this.credentials = null;

    if (this.pool) {
      const oldPool = this.pool;
      this.pool = null;
      oldPool.end().catch((error: unknown) => {
        this.logger.error(
          "Error closing old connection pool during rotation:",
          error as Error,
        );
      });
    }
  }

  /** Fetch username from Databricks */
  private async fetchUsername(): Promise<string> {
    const workspaceClient = this.getWorkspaceClient();
    const user = await workspaceClient.currentUser.me();
    if (!user.userName) {
      throw new Error("Failed to get current user from Databricks workspace");
    }
    return user.userName;
  }

  /** Fetch password (OAuth token) from Databricks */
  private async fetchPassword(): Promise<{ token: string; expiresAt: number }> {
    const workspaceClient = this.getWorkspaceClient();
    const config = new Config({ host: workspaceClient.config.host });
    const apiClient = new ApiClient(config);

    if (!this.connectionConfig.appName) {
      throw new Error(`Database app name not found in connection config`);
    }

    const credentials = await apiClient.request({
      path: `/api/2.0/database/credentials`,
      method: "POST",
      headers: new Headers(),
      raw: false,
      payload: {
        instance_names: [this.connectionConfig.appName],
        request_id: randomUUID(),
      },
    });

    if (!this.validateCredentials(credentials)) {
      throw new Error(
        `Failed to generate credentials for instance: ${this.connectionConfig.appName}`,
      );
    }

    const expiresAt = new Date(credentials.expiration_time).getTime();

    return { token: credentials.token, expiresAt };
  }

  /** Check if error is auth failure */
  private isAuthError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as any).code === "28P01"
    );
  }

  /** Check if error is transient */
  private isTransientError(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return false;
    }

    const code = (error as any).code;
    return (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "57P01" || // admin_shutdown
      code === "57P03" || // cannot_connect_now
      code === "08006" || // connection_failure
      code === "08003" || // connection_does_not_exist
      code === "08000" // connection_exception
    );
  }

  /** Type guard for credentials */
  private validateCredentials(
    value: unknown,
  ): value is { token: string; expiration_time: string } {
    if (typeof value !== "object" || value === null) {
      return false;
    }

    const credentials = value as { token: string; expiration_time: string };
    return (
      "token" in credentials &&
      typeof credentials.token === "string" &&
      "expiration_time" in credentials &&
      typeof credentials.expiration_time === "string" &&
      new Date(credentials.expiration_time).getTime() > Date.now()
    );
  }

  /** Parse connection configuration from config or environment */
  private parseConnectionConfig(): LakebaseConnectionConfig {
    if (this.config.connectionString) {
      return this.parseConnectionString(this.config.connectionString);
    }

    // get connection from config
    if (this.config.host && this.config.database && this.config.appName) {
      return {
        host: this.config.host,
        database: this.config.database,
        port: this.config.port ?? 5432,
        sslMode: this.config.sslMode ?? "require",
        appName: this.config.appName,
      };
    }

    // get connection from environment variables
    const pgHost = process.env.PGHOST;
    const pgDatabase = process.env.PGDATABASE;
    const pgAppName = process.env.PGAPPNAME;
    if (!pgHost || !pgDatabase || !pgAppName) {
      throw new Error(
        "Lakebase connection not configured. Required env vars: PGHOST, PGDATABASE, PGAPPNAME. " +
          "Optional: PGPORT (default: 5432), PGSSLMODE (default: require).",
      );
    }
    const pgPort = process.env.PGPORT;
    const port = pgPort ? parseInt(pgPort, 10) : 5432;

    if (Number.isNaN(port)) {
      throw new Error(`Invalid port: ${pgPort}. Must be a number.`);
    }

    const pgSSLMode = process.env.PGSSLMODE;
    const sslMode =
      (pgSSLMode as "require" | "disable" | "prefer") || "require";

    return {
      host: pgHost,
      database: pgDatabase,
      port,
      sslMode,
      appName: pgAppName,
    };
  }

  private parseConnectionString(
    connectionString: string,
  ): LakebaseConnectionConfig {
    const url = new URL(connectionString);
    const appName = url.searchParams.get("appName");
    if (!appName) {
      throw new Error("Connection string must include appName parameter");
    }

    return {
      host: url.hostname,
      database: url.pathname.slice(1), // remove leading slash
      port: url.port ? parseInt(url.port, 10) : 5432,
      sslMode:
        (url.searchParams.get("sslmode") as "require" | "disable" | "prefer") ??
        "require",
      appName: appName,
    };
  }
}
