/**
 * Observability types for the task system
 * These interfaces provide a zero-dependency interface for tracing, metrics, and logging.
 * Consumers can implement these to integrate with their preferred telemetry system
 */

/**
 * Span context for distributed tracing
 * Matches OpenTelemetry span context structure for easy integration
 */
export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

/**
 * Span status for indicating success or failure
 */
export type SpanStatus = "ok" | "error" | "unset";

/**
 * Attributes that can be attached to spans, metrics and logs
 */
export type Attributes = Record<string, string | number | boolean | undefined>;

/**
 * A span represents a unit of work with timing information
 * Simplified interface that maps to OpenTelemetry Span interface
 */
export interface Span {
  /** Set a single attribute */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Set multiple attributes */
  setAttributes(attributes: Attributes): void;
  /** Record an event within the span */
  addEvent(name: string, attributes?: Attributes): void;
  /** Set the span status */
  setStatus(status: SpanStatus, message?: string): void;
  /** Record an exception */
  recordException(error: Error): void;
  /** End the span (records duration) */
  end(): void;
  /** Get the span context */
  getContext(): SpanContext;
}

/**
 * Metric value structure for recording measurements
 */
export interface MetricValue {
  name: string;
  value: number;
  unit?: string;
  attributes?: Attributes;
}

/**
 * Log severity levels
 */
export type LogSeverity = "debug" | "info" | "warn" | "error";

/**
 * A log record with structured data
 */
export interface LogRecord {
  severity: LogSeverity;
  message: string;
  attributes?: Attributes;
  error?: Error;
  spanContext?: SpanContext;
}

/**
 * Callback function type for span operations
 * Supports both synchronous and asynchronous callbacks
 */
export type SpanCallback<T> = (span: Span) => T | Promise<T>;
