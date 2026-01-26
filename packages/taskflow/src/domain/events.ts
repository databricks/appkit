import {
  type EventId,
  eventId,
  type IdempotencyKey,
  type TaskId,
  type TaskName,
  type UserId,
} from "@/core/branded";
import type { TaskType } from "@/core/types";
import type { TaskExecutionOptions } from "./types";

/**
 * Base event types that handlers can yield
 */
export type TaskEventType =
  | "created"
  | "start"
  | "progress"
  | "complete"
  | "error"
  | "cancelled"
  | "heartbeat"
  | "retry"
  | "recovered"
  | "custom";

/**
 * What handlers yield - minimal input from user code
 *
 * @example
 * yield { type: "progress", message: "Running query", payload: { statementId: "abc123" } }
 */
export interface TaskEventInput {
  /** Optional event ID (auto-generated if not provided) */
  id?: string;
  /** Event type */
  type: TaskEventType;
  /** Human-readable message for the event */
  message?: string;
  /** Result data (for completed events) */
  result?: unknown;
  /** Error message (for error events) */
  error?: string;
  /** Additional payload data for recovery */
  payload?: Record<string, unknown>;
  /** Custom event name (for custom events) */
  eventName?: string;
  /** Task input (for created events) */
  input?: unknown;
  /** Duration in milliseconds (for complete/error events) */
  durationMs?: number;
  /** Event timestamp (auto-set if not provided) */
  timestamp?: number;
  /** Current attempt number */
  attempt?: number;
  /** Maximum retry attempts */
  maxAttempts?: number;
  /** Delay until next retry in milliseconds (for retry events) */
  nextRetryDelayMs?: number;
  /** Whether the error is retryable */
  retryable?: boolean;
}

/**
 * Context provided to task handlers during execution
 */
export interface TaskEventContext {
  /** Unique task ID */
  taskId: TaskId;
  /** Task name/template */
  name: TaskName;
  /** Idempotency key for deduplication */
  idempotencyKey: IdempotencyKey;
  /** User ID */
  userId: UserId | null;
  /** Task type */
  taskType: TaskType;
  /** Execution options */
  executionOptions?: TaskExecutionOptions;
}

/**
 * Normalized event with task context - used in streams and internal processing
 */
export interface TaskEvent extends TaskEventInput {
  /** Unique event ID */
  id: EventId;
  /** Task ID this event belongs to */
  taskId: TaskId;
  /** Task name/template */
  name: TaskName;
  /** Idempotency key for the task */
  idempotencyKey: IdempotencyKey;
  /** User ID */
  userId: UserId | null;
  /** Task type */
  taskType: TaskType;
  /** Task input (included for context) */
  input?: unknown;
  /** Execution options (included for context) */
  executionOptions?: TaskExecutionOptions;
}

export type EventLogEntryType =
  | "TASK_CREATED"
  | "TASK_START"
  | "TASK_PROGRESS"
  | "TASK_COMPLETE"
  | "TASK_ERROR"
  | "TASK_CANCELLED"
  | "TASK_HEARTBEAT" // WAL only, not stored in task_events
  | "TASK_CUSTOM";

/**
 * Entry written to Write-Ahead Log
 */
export interface EventLogEntry {
  /** Entry type */
  type: EventLogEntryType;
  /** Task ID */
  taskId: string;
  /** Idempotency key */
  idempotencyKey: string;
  /** Task name */
  name: string;
  /** User ID */
  userId: string | null;
  /** Task type */
  taskType: TaskType;
  /** Event timestamp */
  timestamp: number;
  /** Task input (for TASK_CREATED) */
  input?: unknown;
  /** Event payload (custom fields from handler) */
  payload?: Record<string, unknown>;
  /** Task result (for TASK_COMPLETE) */
  result?: unknown;
  /** Error message (for TASK_ERROR) */
  error?: string;
  /** Execution options (for TASK_CREATED) */
  executionOptions?: TaskExecutionOptions;
}

/**
 * Maps TaskEventType to EventLogEntryType.
 *
 * Returns null for events that should not be persisted to WAL
 */
export function toEventLogEntryType(
  type: TaskEventType,
): EventLogEntryType | null {
  const mapping: Record<TaskEventType, EventLogEntryType | null> = {
    created: "TASK_CREATED",
    start: "TASK_START",
    progress: "TASK_PROGRESS",
    complete: "TASK_COMPLETE",
    error: "TASK_ERROR",
    cancelled: "TASK_CANCELLED",
    heartbeat: "TASK_HEARTBEAT",
    retry: null, // not persisted to WAL - attempt count is in tasks table
    recovered: null, // internal event, not persisted
    custom: "TASK_CUSTOM",
  };
  return mapping[type];
}

/**
 * Maps EventLogEntryType to TaskEventType.
 */
export function toTaskEventType(type: EventLogEntryType): TaskEventType {
  const mapping: Record<EventLogEntryType, TaskEventType> = {
    TASK_CREATED: "created",
    TASK_START: "start",
    TASK_PROGRESS: "progress",
    TASK_COMPLETE: "complete",
    TASK_ERROR: "error",
    TASK_CANCELLED: "cancelled",
    TASK_HEARTBEAT: "heartbeat",
    TASK_CUSTOM: "custom",
  };

  return mapping[type];
}

/**
 * Determines if an event type should be stored in the task_events table
 *
 * TASK_HEARTBEAT is WAL-only, not stored in task_events table
 */
export function shouldStoreInTaskEvents(type: EventLogEntryType): boolean {
  return type !== "TASK_HEARTBEAT";
}

/**
 * Determines if an event type is relevant for recovery
 *
 * These events should be replayed during task recovery
 */
export function isRecoveryRelevant(type: EventLogEntryType): boolean {
  return (
    type === "TASK_CREATED" ||
    type === "TASK_PROGRESS" ||
    type === "TASK_COMPLETE" ||
    type === "TASK_ERROR" ||
    type === "TASK_CANCELLED" ||
    type === "TASK_CUSTOM"
  );
}

/**
 * Creates a TaskEvent from a TaskEventInput with full metadata
 */
export function createTaskEvent(
  input: TaskEventInput,
  context: TaskEventContext,
): TaskEvent {
  return {
    ...input,
    id: input.id ? eventId(input.id) : generateEventId(),
    taskId: context.taskId,
    name: context.name,
    idempotencyKey: context.idempotencyKey,
    userId: context.userId,
    taskType: context.taskType,
    executionOptions: context.executionOptions,
    timestamp: input.timestamp || Date.now(),
  };
}

/**
 * Converts a TaskEvent to an EventLogEntry for WAL persistence
 */
export function toEventLogEntry(event: TaskEvent): EventLogEntry | null {
  const entryType = toEventLogEntryType(event.type);
  if (!entryType) return null;

  return {
    type: entryType,
    taskId: event.taskId,
    idempotencyKey: event.idempotencyKey,
    name: event.name,
    userId: event.userId ?? null,
    taskType: event.taskType,
    timestamp: event.timestamp ?? Date.now(),
    input: event.input,
    payload: event.payload,
    result: event.result,
    error: event.error,
    executionOptions: event.executionOptions,
  };
}

/**
 * Generates a unique event ID
 */
function generateEventId(): EventId {
  return eventId(
    `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
  );
}
