/**
 * @databricks/taskflow - Durable task execution system
 *
 * A standalone, zero-dependency task execution library with:
 * - Write-ahead log for durability
 * - Event streaming with reconnection support
 * - Retry with exponential backoff
 * - Dead letter queue for failed tasks
 * - Background task recovery
 */

export {
  type EventId,
  eventId,
  type IdempotencyKey,
  idempotencyKey,
  type TaskId,
  type TaskName,
  taskId,
  taskName,
  type UserId,
  userId,
} from "./core/branded";

export {
  BackpressureError,
  ConfigValidationError,
  ConflictError,
  type ErrorCode,
  ErrorCodes,
  type ErrorContext,
  EventLogError,
  type HTTP429Response,
  InitializationError,
  InvalidPathError,
  isRetryableError,
  isTaskSystemError,
  NotFoundError,
  RepositoryError,
  RetryExhaustedError,
  SlotTimeoutError,
  StreamOverflowError,
  TaskStateError,
  TaskSystemError,
  ValidationError,
} from "./core/errors";
export {
  isTerminalStatus,
  isValidTransition,
  type TaskStatus,
  type TaskType,
  VALID_TRANSITIONS,
} from "./core/types";
export { RingBuffer } from "./delivery/ring-buffer";
// Delivery
export { StreamManager } from "./delivery/stream";
export type {
  StreamConfig,
  StreamStats,
  StreamTaskEvent,
  TaskStream,
  TaskStreamOptions,
} from "./delivery/types";
// Domain
export {
  createTaskEvent,
  type EventLogEntry,
  type EventLogEntryType,
  isRecoveryRelevant,
  shouldStoreInTaskEvents,
  type TaskEvent,
  type TaskEventContext,
  type TaskEventInput,
  // Events
  type TaskEventType,
  toEventLogEntry,
  toEventLogEntryType,
  toTaskEventType,
} from "./domain/events";
export {
  type GeneratorTaskHandler,
  isAsyncGenerator,
  type PromiseTaskHandler,
  type RecoveryContext,
  type RecoveryHandler,
  type TaskDefinition,
  type TaskHandler,
  type TaskHandlerContext,
  type TaskHandlerResult,
} from "./domain/handler";
export { Task } from "./domain/task";
export type {
  StoredEventType,
  TaskCreationParams,
  TaskEventRecord,
  TaskExecutionOptions,
  TaskJSON,
  TaskRecord,
} from "./domain/types";
export { TaskExecutor, type TaskExecutorDeps } from "./execution/executor";
export { TaskRecovery, type TaskRecoveryDeps } from "./execution/recovery";
export {
  TaskSystem,
  TaskSystem as createTaskSystem,
  type TaskSystemConfig,
} from "./execution/system";
export {
  DEFAULT_EXECUTOR_CONFIG,
  DEFAULT_RECOVERY_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_SHUTDOWN_CONFIG,
  type ExecutorConfig,
  type ExecutorStats,
  type RecoveryConfig,
  type RecoveryStats,
  type RetryConfig,
  type ShutdownConfig,
  type ShutdownOptions,
  type TaskEventSubscriber,
  type TaskRecoveryParams,
  type TaskRunParams,
  type TaskSystemStats,
  type TaskSystemStatus,
  type TaskTemplate,
} from "./execution/types";
export { Flush } from "./flush/flush-manager";
export { FlushWorker } from "./flush/flush-worker";
export type {
  FlushConfig,
  FlushStats,
  FlushStatus,
  FlushWorkerRuntimeStats,
  FlushWorkerStats,
  IPCCommand,
  IPCMessage,
} from "./flush/types";
export { Backpressure } from "./guard/backpressure";
export { DeadLetterQueue } from "./guard/dlq";
export { Guard } from "./guard/guard";
export { SlotManager } from "./guard/slot-manager";
export type {
  AdmissionStats,
  BackpressureConfig,
  DLQConfig,
  DLQEntry,
  DLQEvent,
  DLQEventListener,
  DLQEventType,
  DLQStats,
  GuardConfig,
  GuardStats,
  RecoverySlotConfig,
  RecoverySlotStats,
  SlotManagerConfig,
  SlotStats,
} from "./guard/types";
export {
  defaultValidator,
  TaskValidator,
  validateInputSchema,
  validateTaskInput,
} from "./guard/validator";
export type {
  Attributes,
  LogRecord,
  LogSeverity,
  Span,
  SpanCallback,
  SpanContext,
  SpanStatus,
  TaskSystemHooks,
} from "./observability";
export {
  createHooks,
  NoopSpan,
  noopHooks,
  TaskAttributes,
  TaskMetrics,
  TaskSpans,
} from "./observability";
export { EventLog } from "./persistence/event-log";
export { createRepository } from "./persistence/repository";
export type {
  BaseRepositoryConfig,
  RepositoryType,
  StoredEvent,
  TaskRepository,
} from "./persistence/repository/types";
export type {
  EventLogConfig,
  EventLogEvent,
  EventLogStats,
} from "./persistence/types";
