import {
  type Counter,
  type Histogram,
  type Span,
  type SpanContext,
  TraceFlags,
} from "@opentelemetry/api";

const NOOP_SPAN_CONTEXT: SpanContext = {
  traceId: "00000000000000000000000000000000",
  spanId: "0000000000000000",
  traceFlags: TraceFlags.NONE,
};

export const NOOP_SPAN: Span = {
  spanContext: () => NOOP_SPAN_CONTEXT,
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  addLink: () => NOOP_SPAN,
  addLinks: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  updateName: () => NOOP_SPAN,
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
};

export const NOOP_COUNTER: Counter = {
  add: () => {},
};

export const NOOP_HISTOGRAM: Histogram = {
  record: () => {},
};
