/**
 * SQLite repository Types
 *
 * Types specific to the SQLite repository implementation
 */

import type { TaskStatus, TaskType } from "@/core/types";
import type { BaseRepositoryConfig } from "../types";

/**
 * SQLite repository configuration
 */
export interface SQLiteRepositoryConfig extends BaseRepositoryConfig {
  type: "sqlite";
  /** path to the SQLite database file */
  database: string;
}

/**
 * SQLite connector configuration
 */
export interface SQLiteConfig {
  /** path to the SQLite database file */
  database: string;
}

/**
 * Raw SQLite task record from the database
 * Column names use snake_case to match SQL conventions
 */
export interface SQLiteTaskRecord {
  /** task id (primary_key) */
  task_id: string;
  /** task name/template */
  name: string;
  /** current status */
  status: TaskStatus;
  /** task type: 'user' or 'background' */
  type: TaskType;
  /** idempotency key for deduplication */
  idempotency_key: string;
  /** user id (null for background tasks) */
  user_id: string | null;
  /** JSON-stringified input data */
  input_data: string | null;
  /** JSON-stringified execution options */
  execution_options: string | null;
  /** ISO timestamp when created */
  created_at: string;
  /** ISO timestamp when started */
  started_at: string | null;
  /** ISO timestamp when completed */
  completed_at: string | null;
  /** duration in milliseconds */
  duration_ms: number | null;
  /** JSON-stringified result */
  result: string | null;
  /** error message */
  error: string | null;
  /** attempt count */
  attempt: number;
  /** ISO timestamp of last heartbeat */
  last_heartbeat_at: string;
}

/**
 * Raw SQLite task event record from the database
 */
export interface SQLiteTaskEventRecord {
  /** event entry id (primary_key) */
  entry_id: string;
  /** task id (foreign_key) */
  task_id: string;
  /** sequence number within the task */
  seq: number;
  /** event type */
  type: TaskType;
  /** ISO timestamp of the event */
  timestamp: string;
  /** ISO timestamp when inserted */
  created_at: string;
  /** JSON-stringified payload */
  payload: string | null;
}
