// Our own noop tracer implementation.
// Why?
// Unfortunately, noop tracer is not exported from the api package, unlike noop meter and noop logger.
// Read more: https://github.com/open-telemetry/opentelemetry-js/issues/3455
// and https://github.com/open-telemetry/opentelemetry-js/issues/4518
//
// The original implementation is here: https://github.com/open-telemetry/opentelemetry-js/blob/a7acd9355cd0c1da63d285dfb960efeacc3cbc15/api/src/trace/NoopTracer.ts#L32
// licensed under the Apache License 2.0.
// Our own implementation is much simpler but will do the job for our needs.

import type {
  Context,
  Span,
  SpanContext,
  SpanOptions,
  Tracer,
} from "@opentelemetry/api";
import {
  createNoopMeter,
  INVALID_SPAN_CONTEXT,
  type SpanStatusCode,
} from "@opentelemetry/api";

class NonRecordingSpan implements Span {
  private readonly _spanContext: SpanContext;

  constructor(spanContext: SpanContext = INVALID_SPAN_CONTEXT) {
    this._spanContext = spanContext;
  }

  spanContext(): SpanContext {
    return this._spanContext;
  }

  setAttribute(_key: string, _value: any): this {
    return this;
  }

  setAttributes(_attributes: any): this {
    return this;
  }

  addEvent(
    _name: string,
    _attributesOrStartTime?: any,
    _startTime?: any,
  ): this {
    return this;
  }

  addLink(_link: any): this {
    return this;
  }

  addLinks(_links: any[]): this {
    return this;
  }

  setStatus(_status: { code: SpanStatusCode; message?: string }): this {
    return this;
  }

  updateName(_name: string): this {
    return this;
  }

  end(_endTime?: number): void {}

  isRecording(): boolean {
    return false;
  }

  recordException(_exception: any, _time?: number): void {}
}

export class NoopTracer implements Tracer {
  startSpan(_name: string, _options?: SpanOptions, _context?: Context): Span {
    return new NonRecordingSpan(INVALID_SPAN_CONTEXT);
  }

  startActiveSpan<F extends (span: Span) => any>(
    _name: string,
    ...args: [F] | [SpanOptions, F] | [SpanOptions, Context, F]
  ): ReturnType<F> | undefined {
    const fn = args[args.length - 1] as F;

    if (typeof fn !== "function") {
      return undefined as ReturnType<F>;
    }

    return fn(new NonRecordingSpan(INVALID_SPAN_CONTEXT));
  }
}

export const NOOP_TRACER = new NoopTracer();
export const NOOP_METER = createNoopMeter();
export { NOOP_LOGGER } from "@opentelemetry/api-logs";
