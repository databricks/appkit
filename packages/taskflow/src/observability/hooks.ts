import type { Attributes, LogRecord, SpanCallback, SpanContext } from "./types";

/**
 * Hook interface for task system observability
 *
 * Consumers implement this interface to integrate with their
 * preferred telemetry system
 *
 * All methods have sensible no-op defaults, so consumers only
 * need to implement what they care about.
 */
export interface TaskSystemHooks {
  /**
   * Start a span and execute a callback within it.
   * The span is automatically ended when the callback completes.
   *
   * @param name - The name of the span (e.g. "task.execute")
   * @param attributes - Initial span attributes
   * @param fn - Callback to execute within the span
   * @returns The callback's return value
   */
  withSpan<T>(
    name: string,
    attributes: Attributes,
    fn: SpanCallback<T>,
  ): T | Promise<T>;

  /**
   * Get the current active span context for propagation.
   * Returns undefined if no span is active.
   */
  getActiveSpanContext(): SpanContext | undefined;

  /**
   * Increment a counter metric.
   * @param name - Metric name
   * @param value - Amount to increment by
   * @param attributes - Metric attributes/labels
   */
  incrementCounter(name: string, value?: number, attributes?: Attributes): void;

  /**
   * Record a gauge value.
   * @param name - Metric name
   * @param value - Value to record
   * @param attributes - Metric attributes/label
   */
  recordGauge(name: string, value: number, attributes?: Attributes): void;

  /**
   * Record a histogram metric.
   * @param name - Metric name
   * @param value - Value to record
   * @param attributes - Metric attributes/label
   */
  recordHistogram(name: string, value: number, attributes?: Attributes): void;

  /**
   * Emit a structured log record.
   * @param record - The log record to emit
   */
  log(record: LogRecord): void;
}

/**
 * Semantic metric names used by the task system
 * Consumers can use these for dashboards and alerts
 */
export const TaskMetrics = {
  // counters
  TASKS_CREATED: "taskflow.tasks.created",
  TASKS_STARTED: "taskflow.tasks.started",
  TASKS_COMPLETED: "taskflow.tasks.completed",
  TASKS_FAILED: "taskflow.tasks.failed",
  TASKS_CANCELLED: "taskflow.tasks.cancelled",
  TASKS_RETRIED: "taskflow.tasks.retried",
  TASKS_RECOVERED: "taskflow.tasks.recovered",

  FLUSH_BATCHES: "taskflow.flush.batches",
  FLUSH_ENTRIES: "taskflow.flush.entries",
  FLUSH_ERRORS: "taskflow.flush.errors",

  GUARD_REJECTIONS: "taskflow.guard.rejections",
  DLQ_ADDED: "taskflow.dlq.added",
  DLQ_RETRIED: "taskflow.dlq.retried",

  // gauges
  TASKS_RUNNING: "taskflow.tasks.running",
  TASKS_QUEUED: "taskflow.tasks.queued",
  SLOTS_AVAILABLE: "taskflow.slots.available",
  DLQ_SIZE: "taskflow.dlq.size",
  STREAMS_ACTIVE: "taskflow.streams.active",

  // histograms
  TASK_DURATION_MS: "taskflow.task.duration_ms",
  TASK_QUEUE_WAIT_MS: "taskflow.task.queue_wait_ms",
  FLUSH_DURATION_MS: "taskflow.flush.duration_ms",
  FLUSH_BATCH_SIZE: "taskflow.flush.batch_size",
} as const;

/**
 * Semantic span names used by the task system.
 */
export const TaskSpans = {
  TASK_EXECUTE: "taskflow.task.execute",
  TASK_HANDLER: "taskflow.task.handler",
  TASK_RETRY: "taskflow.task.retry",
  TASK_RECOVER: "taskflow.task.recover",

  FLUSH_BATCH: "taskflow.flush.batch",
  FLUSH_WRITE: "taskflow.flush.write",

  GUARD_ADMIT: "taskflow.guard.admit",
  GUARD_ACQUIRE_SLOT: "taskflow.guard.acquire_slot",

  STREAM_PUSH: "taskflow.stream.push",
  STREAM_GENERATE: "taskflow.stream.generate",

  REPOSITORY_QUERY: "taskflow.repository.query",
  REPOSITORY_WRITE: "taskflow.repository.write",
} as const;

/**
 * Common attribute keys for span and metrics
 */
export const TaskAttributes = {
  TASK_ID: "taskflow.task.id",
  TASK_NAME: "taskflow.task.name",
  TASK_TYPE: "taskflow.task.type",
  TASK_STATUS: "taskflow.task.status",
  TASK_ATTEMPT: "taskflow.task.attempt",

  USER_ID: "taskflow.user.id",
  IDEMPOTENCY_KEY: "taskflow.idempotency.key",

  ERROR_TYPE: "taskflow.error.type",
  ERROR_MESSAGE: "taskflow.error.message",
  ERROR_RETRYABLE: "taskflow.error.retryable",

  FLUSH_BATCH_SIZE: "taskflow.flush.batch_size",
  REPOSITORY_TYPE: "taskflow.repository.type",
} as const;
