import type pg from "pg";
import type { BaseRepositoryConfig } from "../types";

/**
 * Lakebase Repository Types
 *
 * Types for Lakebase/Postgres repository implementation
 * The consumer provides the connector (no pg_deps)
 */
export interface LakebaseConnector {
  /**
   * Execute a SQL query
   * @param sql - SQL query string $1, $2, etc. placeholders
   * @params params -Query parameters
   * @returns Query result with rows
   */
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;

  /**
   * Execute a function within a transaction
   * @param callback - Function to execute within the transaction context
   */
  transaction<T>(
    callback: (client: LakebaseTransactionClient) => Promise<T>,
  ): Promise<T>;

  /**
   * Check if the connector is healthy
   */
  healthCheck(): Promise<boolean>;

  /**
   * Close the connection
   */
  close(): Promise<void>;
}

/**
 * Transaction client interface
 */
export interface LakebaseTransactionClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

/**
 * Lakebase repository configuration
 */
export interface LakebaseRepositoryConfig extends BaseRepositoryConfig {
  type: "lakebase";
  connector: LakebaseConnector;
}

/**
 * Raw task record from lakebase database
 */
export interface LakebaseTaskRecord {
  task_id: string;
  name: string;
  status: string;
  type: string;
  idempotency_key: string;
  user_id: string | null;
  input_data: string | null;
  execution_options: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  result: string | null;
  error: string | null;
  attempt: number;
  last_heartbeat_at: string;
}

/**
 * raw task event record from Lakebase database
 */
export interface LakebaseTaskEventRecord {
  entry_id: string;
  task_id: string;
  seq: number;
  type: string;
  timestamp: string;
  created_at: string;
  payload: string | null;
}
