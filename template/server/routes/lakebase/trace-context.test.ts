{{if .plugins.lakebase -}}
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, ROOT_CONTEXT, trace, TraceFlags, type SpanContext } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { withLakebaseTraceContext } from './trace-context';

const TRACE_A = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACE_B = '70f5c2a87bdb4a84a8f5eab6329b86db';
const SPAN_A = '00f067aa0ba902b7';
const SPAN_B = '8f3b1c42d5e60718';

function runWithSpan<T>(spanContext: SpanContext, fn: () => T): T {
  const span = trace.wrapSpanContext(spanContext);
  return context.with(trace.setSpan(context.active(), span), fn);
}

describe('withLakebaseTraceContext', () => {
  beforeAll(() => {
    context.disable();
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(() => {
    context.disable();
  });

  test('adds the valid active span and preserves its trace flags', async () => {
    const params = ['todo-title'];
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const lakebase = withLakebaseTraceContext({ query }, 'orders-app');

    await runWithSpan(
      { traceId: TRACE_A, spanId: SPAN_A, traceFlags: TraceFlags.NONE },
      () => lakebase.query('SELECT * FROM app.todos WHERE title = $1', params),
    );

    expect(query).toHaveBeenCalledWith(
      `/*traceparent='00-${TRACE_A}-${SPAN_A}-00',service='orders-app'*/\nSELECT * FROM app.todos WHERE title = $1`,
      params,
    );
  });

  test('keeps sampled flags instead of hard-coding them', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const lakebase = withLakebaseTraceContext({ query }, 'orders-app');

    await runWithSpan(
      { traceId: TRACE_A, spanId: SPAN_A, traceFlags: TraceFlags.SAMPLED },
      () => lakebase.query('SELECT 1'),
    );

    expect(query).toHaveBeenCalledWith(
      `/*traceparent='00-${TRACE_A}-${SPAN_A}-01',service='orders-app'*/\nSELECT 1`,
      undefined,
    );
  });

  test('formats uppercase valid span IDs as lowercase W3C hex', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const lakebase = withLakebaseTraceContext({ query }, 'orders-app');

    await runWithSpan(
      { traceId: TRACE_A.toUpperCase(), spanId: SPAN_A.toUpperCase(), traceFlags: TraceFlags.SAMPLED },
      () => lakebase.query('SELECT 1'),
    );

    expect(query).toHaveBeenCalledWith(
      `/*traceparent='00-${TRACE_A}-${SPAN_A}-01',service='orders-app'*/\nSELECT 1`,
      undefined,
    );
  });

  test('uses the app name when OTEL_SERVICE_NAME is empty', async () => {
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    vi.stubEnv('DATABRICKS_APP_NAME', 'inventory-app');
    try {
      const query = vi.fn(() => Promise.resolve({ rows: [] }));
      const lakebase = withLakebaseTraceContext({ query });
      await runWithSpan(
        { traceId: TRACE_A, spanId: SPAN_A, traceFlags: TraceFlags.SAMPLED },
        () => lakebase.query('SELECT 1'),
      );
      expect(query).toHaveBeenCalledWith(
        `/*traceparent='00-${TRACE_A}-${SPAN_A}-01',service='inventory-app'*/\nSELECT 1`,
        undefined,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test.each([
    ['missing', undefined],
    [
      'invalid',
      {
        traceId: '00000000000000000000000000000000',
        spanId: '0000000000000000',
        traceFlags: TraceFlags.SAMPLED,
      } satisfies SpanContext,
    ],
  ])('executes SQL unchanged when the active context is %s', async (_name, spanContext) => {
    const params = [42];
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const lakebase = withLakebaseTraceContext({ query }, 'orders-app');
    const execute = () => lakebase.query('SELECT * FROM app.todos WHERE id = $1', params);

    if (spanContext) {
      await runWithSpan(spanContext, execute);
    } else {
      await context.with(ROOT_CONTEXT, execute);
    }

    expect(query).toHaveBeenCalledWith('SELECT * FROM app.todos WHERE id = $1', params);
  });

  test('isolates concurrent request contexts and keeps parameter binding', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      await Promise.resolve();
      calls.push({ text, params });
      return { rows: [] };
    });
    const lakebase = withLakebaseTraceContext({ query }, 'orders-app');
    const paramsA = ['a'];
    const paramsB = ['b'];

    await Promise.all([
      runWithSpan({ traceId: TRACE_A, spanId: SPAN_A, traceFlags: TraceFlags.SAMPLED }, async () => {
        await Promise.resolve();
        await lakebase.query('SELECT $1', paramsA);
      }),
      runWithSpan({ traceId: TRACE_B, spanId: SPAN_B, traceFlags: TraceFlags.NONE }, async () => {
        await Promise.resolve();
        await lakebase.query('SELECT $1', paramsB);
      }),
    ]);

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          text: `/*traceparent='00-${TRACE_A}-${SPAN_A}-01',service='orders-app'*/\nSELECT $1`,
          params: paramsA,
        },
        {
          text: `/*traceparent='00-${TRACE_B}-${SPAN_B}-00',service='orders-app'*/\nSELECT $1`,
          params: paramsB,
        },
      ]),
    );
  });

  test('uses a real exported span as the SQL correlation identity', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.disable();
    trace.setGlobalTracerProvider(provider);

    try {
      const query = vi.fn((_text: string, _params?: unknown[]) => Promise.resolve({ rows: [] }));
      const lakebase = withLakebaseTraceContext({ query }, 'orders-app');
      const params = ['a'];

      await trace.getTracer('test').startActiveSpan('http.request', async (span) => {
        try {
          await lakebase.query('SELECT $1', params);
        } finally {
          span.end();
        }
      });

      const exportedSpan = exporter.getFinishedSpans()[0];
      expect(exportedSpan.name).toBe('http.request');
      expect(query).toHaveBeenCalledWith(
        `/*traceparent='00-${exportedSpan.spanContext().traceId}-${exportedSpan.spanContext().spanId}-01',service='orders-app'*/\nSELECT $1`,
        params,
      );
    } finally {
      trace.disable();
      await provider.shutdown();
    }
  });

  test('sanitizes the service label before putting it in a SQL comment', async () => {
    const query = vi.fn((_text: string) => Promise.resolve({ rows: [] }));
    const lakebase = withLakebaseTraceContext({ query }, "orders'*/\nDROP TABLE app.todos; --");

    await runWithSpan(
      { traceId: TRACE_A, spanId: SPAN_A, traceFlags: TraceFlags.SAMPLED },
      () => lakebase.query('SELECT 1'),
    );

    const sql = query.mock.calls[0][0];
    const match = sql.match(/^\/\*traceparent='00-[0-9a-f]{32}-[0-9a-f]{16}-01',service='([^']+)'\*\/\nSELECT 1$/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/^[A-Za-z0-9._:/-]{1,128}$/);
    expect(sql).not.toContain('DROP TABLE app.todos;');
  });

  test('propagates query errors and reads context again on the next execution', async () => {
    const failure = new Error('database unavailable');
    const query = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ rows: [] });
    const lakebase = withLakebaseTraceContext({ query }, 'orders-app');
    const params = [42];

    await expect(runWithSpan(
      { traceId: TRACE_A, spanId: SPAN_A, traceFlags: TraceFlags.SAMPLED },
      () => lakebase.query('SELECT $1', params),
    )).rejects.toBe(failure);
    await runWithSpan(
      { traceId: TRACE_B, spanId: SPAN_B, traceFlags: TraceFlags.NONE },
      () => lakebase.query('SELECT $1', params),
    );

    expect(query.mock.calls[0]).toEqual([
      `/*traceparent='00-${TRACE_A}-${SPAN_A}-01',service='orders-app'*/\nSELECT $1`,
      params,
    ]);
    expect(query.mock.calls[1]).toEqual([
      `/*traceparent='00-${TRACE_B}-${SPAN_B}-00',service='orders-app'*/\nSELECT $1`,
      params,
    ]);
  });
});
{{- end}}
