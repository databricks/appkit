import type { IdempotencyKey, TaskName, UserId } from "@/core/branded";
import type { TaskStatus, TaskType } from "@/core/types";

/**
 * Options for task execution behavior
 */
export interface TaskExecutionOptions {
  /** override the default retry configuration  */
  maxRetries?: number;
  /** override the default timeout in milliseconds */
  timeoutMs?: number;
  /** override the default max concurrent executions */
  maxConcurrentExecutions?: number;
}

/**
 * Parameters for creating a new task
 */
export interface TaskCreationParams {
  /** The registered task name/template */
  name: TaskName;
  /** Input data for the task handler */
  input: unknown;
  /** User ID for user-initiated tasks, null for background tasks */
  userId: UserId | null;
  /** Task type: user or background */
  type?: TaskType;
  /** Execution options for the task */
  executionOptions?: TaskExecutionOptions;
  /** Custom idempotency key (auto-generated if not provided) */
  idempotencyKey?: IdempotencyKey;
}

/**
 * Row in `tasks` table
 * Uses snake_case to match SQL database conventions
 */
export interface TaskRecord {
  id: string;
  name: string;
  idempotency_key: string;
  user_id: string | null;
  task_type: TaskType;
  status: TaskStatus;
  input: string;
  result: string | null;
  error: string | null;
  attempt: number;
  created_at: string; // ISO timestamp
  started_at: string | null; // ISO timestamp
  completed_at: string | null; // ISO timestamp
  last_heartbeat_at: string | null; // ISO timestamp
  execution_options: string | null; // JSON stringified
}

/**
 * Event types stored in task_events table
 * Subset of EventLogEntryType - only recovery-relevant events
 */
export type StoredEventType =
  | "TASK_CREATED"
  | "TASK_START"
  | "TASK_PROGRESS"
  | "TASK_COMPLETE"
  | "TASK_ERROR"
  | "TASK_CANCELLED"
  | "TASK_CUSTOM";

/**
 * Row in `task_events` table
 * Uses snake_case to match SQL database conventions
 */
export interface TaskEventRecord {
  id: string;
  task_id: string;
  idempotency_key: string;
  event_type: StoredEventType;
  payload: string | null; // JSON stringified
  created_at: string; // ISO timestamp
}

/**
 * Serialized task representation for JSON responses
 */
export interface TaskJSON {
  id: string;
  name: string;
  input: unknown;
  userId: string | null;
  idempotencyKey: string;
  type: TaskType;
  status: TaskStatus;
  attempt: number;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  durationMs?: number;
  executionOptions?: TaskExecutionOptions;
}
