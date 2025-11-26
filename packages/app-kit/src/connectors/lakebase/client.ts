import { randomUUID } from "node:crypto";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { ApiClient, Config } from "@databricks/sdk-experimental";
import { deepMerge } from "../../utils";
import pg from "pg";
import { lakebaseDefaults } from "./defaults";
import type {
  LakebaseConfig,
  LakebaseConnectionConfig,
  LakebaseCredentials,
} from "./types";
import { parseConnectionString } from "./utils";

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
  private readonly CACHE_BUFFER_MS = 2 * 60 * 1000;
  private readonly config: LakebaseConfig;
  private readonly connectionConfig: LakebaseConnectionConfig;
  private pool: pg.Pool | null = null;
  private credentials: LakebaseCredentials | null = null;

  constructor(userConfig?: Partial<LakebaseConfig>) {
    this.config = deepMerge(lakebaseDefaults, userConfig);

    this.connectionConfig = this.parseConnectionConfig();

    // validate configuration
    if (this.config.maxPoolSize < 1) {
      throw new Error("maxPoolSize must be at least 1");
    }
    if (this.config.credentialTTLMs < 60_000) {
      throw new Error("credentialTTLMs must be at least 60 seconds");
    }
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
    const pool = await this.getPool();

    try {
      return await pool.query<T>(sql, params);
    } catch (error) {
      // retry on auth failure
      if (this.isAuthError(error)) {
        await this.rotateCredentials();
        const newPool = await this.getPool();
        return await newPool.query<T>(sql, params);
      }

      // retry on transient errors, but only once
      if (this.isTransientError(error) && retryCount < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return await this.query<T>(sql, params, retryCount + 1);
      }

      throw error;
    }
  }

  /**
   * Execute a transaction
   *
   * @example
   * ```typescript
   * await connector.transaction(async (client) => {
   *   await client.query('BEGIN');
   *   await client.query('INSERT INTO accounts (name) VALUES ($1)', ['Alice']);
   *   await client.query('INSERT INTO logs (action) VALUES ($1)', ['Created Alice']);
   *   await client.query('COMMIT');
   * });
   * ```
   */
  async transaction<T>(
    callback: (client: pg.PoolClient) => Promise<T>,
    retryCount: number = 0,
  ): Promise<T> {
    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      return await callback(client);
    } catch (error) {
      // retry on auth failure
      if (this.isAuthError(error)) {
        client.release();
        await this.rotateCredentials();
        const newPool = await this.getPool();
        const retryClient = await newPool.connect();
        try {
          return await callback(retryClient);
        } finally {
          retryClient.release();
        }
      }

      // retry on transient errors, but only once
      if (this.isTransientError(error) && retryCount < 1) {
        client.release();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const retryClient = await pool.connect();
        try {
          return await this.transaction<T>(callback, retryCount + 1);
        } finally {
          retryClient.release();
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /** Check if database connection is healthy */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.query<{ result: number }>("SELECT 1 as result");
      return result.rows[0]?.result === 1;
    } catch {
      return false;
    }
  }

  /** Close connection pool (call on shutdown) */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch((error) => {
        console.error("Error closing connection pool:", error);
      });
      this.pool = null;
    }
    this.credentials = null;
  }

  /** Setup graceful shutdown to close connection pools */
  shutdown(): void {
    process.on("SIGTERM", () => this.close());
    process.on("SIGINT", () => this.close());
    this.close();
  }

  /** Get Databricks workspace client - from config or request context */
  private getWorkspaceClient(): WorkspaceClient {
    if (this.config.workspaceClient) {
      return this.config.workspaceClient;
    }

    try {
      const { getRequestContext } = require("../../utils");
      const { serviceDatabricksClient } = getRequestContext();

      // cache it for subsequent calls
      this.config.workspaceClient = serviceDatabricksClient;
      return serviceDatabricksClient;
    } catch (_error) {
      throw new Error(
        "Databricks workspace client not available. Either pass it in config or use within App Kit request context.",
      );
    }
  }

  /** Get or create connection pool */
  private async getPool(): Promise<pg.Pool> {
    if (!this.connectionConfig) {
      throw new Error(
        "Lakebase connection not configured. " +
          "Set LAKEBASE_CONNECTION_STRING env var or provide config in constructor.",
      );
    }

    if (!this.pool) {
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

    pool.on("error", (error) => {
      console.error("Connection pool error:", error.message, {
        code: (error as any).code,
      });
    });

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
      return this.credentials;
    }

    // fetch new credentials
    const username = await this.fetchUsername();
    const password = await this.fetchPassword();

    this.credentials = {
      username,
      password,
      expiresAt: now + this.config.credentialTTLMs,
    };

    return { username, password };
  }

  /** Rotate credentials and recreate pool */
  private async rotateCredentials(): Promise<void> {
    // clear cached credentials
    this.credentials = null;

    if (this.pool) {
      const oldPool = this.pool;
      this.pool = null;
      oldPool.end().catch((error) => {
        console.error(
          "Error closing old connection pool during rotation:",
          error,
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
  private async fetchPassword(): Promise<string> {
    const host = this.connectionConfig.host;

    const uid = host.split(".")[0]?.replace("instance-", "");
    if (!uid) {
      throw new Error(
        `Invalid lakebase hostname: ${host}. Expected format: instance-<uuid>.database.<region>.databricks.com`,
      );
    }

    const workspaceClient = this.getWorkspaceClient();
    const config = new Config({ host: workspaceClient.config.host });
    const apiClient = new ApiClient(config);

    // find database instance
    const dbInfo = await apiClient.request({
      path: `/api/2.0/database/instances:findByUid`,
      method: "GET",
      query: { uid },
      payload: { uid },
      headers: new Headers(),
      raw: false,
    });

    if (!this.hasName(dbInfo)) {
      throw new Error(`Database instance not found for uid: ${uid}`);
    }

    const credentials = await apiClient.request({
      path: `/api/2.0/database/credentials`,
      method: "POST",
      headers: new Headers(),
      raw: false,
      payload: {
        instance_names: [dbInfo.name],
        request_id: randomUUID(),
      },
    });

    if (!this.hasToken(credentials)) {
      throw new Error(
        `Failed to generate credentials for instance: ${dbInfo.name}`,
      );
    }

    return credentials.token;
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

  /** Type guard for database instance */
  private hasName(value: unknown): value is { name: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      typeof (value as any).name === "string"
    );
  }

  /** Type guard for credentials */
  private hasToken(value: unknown): value is { token: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "token" in value &&
      typeof (value as any).token === "string"
    );
  }

  /** Parse connection configuration from config or environment */
  private parseConnectionConfig(): LakebaseConnectionConfig {
    if (this.config.connectionString) {
      const { connectionParams } = parseConnectionString(
        this.config.connectionString,
      );
      return connectionParams;
    }

    const envConnectionString = process.env.LAKEBASE_CONNECTION_STRING;
    if (envConnectionString) {
      const { connectionParams } = parseConnectionString(envConnectionString);
      return connectionParams;
    }

    if (this.config.host && this.config.database) {
      return {
        host: this.config.host,
        database: this.config.database,
        port: this.config.port,
        sslMode: this.config.sslMode,
      };
    }

    throw new Error(
      "Lakebase connection not configured. Either set LAKEBASE_CONNECTION_STRING env var or provide config in constructor.",
    );
  }
}
