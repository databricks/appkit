/**
 * Repository types
 *
 * Defines the abstract repository interface that all persistence
 * implementations must follow
 */

import type { IdempotencyKey, TaskId } from "@/core/branded";
import type { EventLogEntry, StoredEventType, Task } from "@/domain";

/**
 * Supported repository types
 */
export type RepositoryType = "sqlite" | "lakebase";

/**
 * Event stored in the database
 */
export interface StoredEvent {
  /** unique event id */
  id: string;
  /** task this event belongs to */
  taskId: string;
  /** sequence number within the task */
  seq: number;
  /** event type */
  type: StoredEventType;
  /** when the event occurred */
  timestamp: Date;
  /** event payload (parsed json) */
  payload: Record<string, unknown> | null;
}

/**
 * Abstract repository interface
 *
 * All repository implementations must implement this interface
 * The repository is responsible for:
 * - Executing batches of events from the event log
 * - Querying tasks by ID or idempotency key
 * - Finding stale tasks for recovery
 * - Retrieving task events for replay
 */
export interface TaskRepository {
  /** repository type identifier */
  readonly type: RepositoryType;
  /** whether the repository is initialized */
  readonly isInitialized: boolean;
  /**
   * Initialize the repository
   * Creates tables if they don't exist
   */
  initialize(): Promise<void>;

  /**
   * Execute a batch of event log entries
   * Applies events to update task state in a transaction
   */
  executeBatch(entries: EventLogEntry[]): Promise<void>;

  /**
   * Find a task by its ID
   * @returns Task or null if not found
   */
  findById(taskId: TaskId): Promise<Task | null>;

  /**
   * Find a task by its idempotency key
   * @returns Task or null if not found
   */
  findByIdempotencyKey(idempotencyKey: IdempotencyKey): Promise<Task | null>;

  /**
   * Find stale running tasks
   * Tasks are stale if their last heartbeat is older than the threshold
   */
  findStaleTasks(threshold: number): Promise<Task[]>;

  /**
   * Get all events for a task
   * Events are ordered by sequence number
   */
  getEvents(taskId: TaskId): Promise<StoredEvent[]>;

  /**
   * Check if the repository is healthy
   * @returns true if the repository is healthy
   */
  healthCheck(): Promise<boolean>;

  /**
   * Close the repository connection
   */
  close(): Promise<void>;
}

/**
 * Base repository configuration
 */
export interface BaseRepositoryConfig {
  type: RepositoryType;
}
