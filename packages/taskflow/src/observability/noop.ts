import type { TaskSystemHooks } from "./hooks";
import type {
  Attributes,
  LogRecord,
  Span,
  SpanContext,
  SpanStatus,
} from "./types";

/**
 * No-op span implementation.
 * Used when observability is disabled or not configured.
 */
class NoopSpan implements Span {
  setAttribute(
    _key: string,
    _value: string | number | boolean | undefined,
  ): void {}
  setAttributes(_attributes: Attributes): void {}
  addEvent(_name: string, _attributes?: Attributes): void {}
  setStatus(_status: SpanStatus, _message?: string): void {}
  recordException(_error: Error): void {}
  end(): void {}
  getContext(): SpanContext {
    return { traceId: "", spanId: "", traceFlags: 0 };
  }
}

/**
 * Singleton no-op span instance for reuse
 */
const NOOP_SPAN = new NoopSpan();

/**
 * No-op hooks implementation.
 * All methods do nothing - zero overhead when observability is disabled.
 */
export const noopHooks: TaskSystemHooks = {
  withSpan<T>(
    _name: string,
    _attributes: Attributes,
    _fn: (span: Span) => T | Promise<T>,
  ): T | Promise<T> {
    return _fn(NOOP_SPAN);
  },
  getActiveSpanContext(): SpanContext | undefined {
    return undefined;
  },
  incrementCounter(
    _name: string,
    _value?: number,
    _attributes?: Attributes,
  ): void {},
  recordGauge(_name: string, _value: number, _attributes?: Attributes): void {},
  recordHistogram(
    _name: string,
    _value: number,
    _attributes?: Attributes,
  ): void {},

  log(_record: LogRecord): void {},
};

/**
 * Creates a hooks instance with partial implementation.
 * Unimplemented methods fall back to no-op.
 */
export function createHooks(
  partial: Partial<TaskSystemHooks>,
): TaskSystemHooks {
  return { ...noopHooks, ...partial };
}

/**
 * Export NoopSpan for testing purposes
 */
export { NoopSpan, NOOP_SPAN };
