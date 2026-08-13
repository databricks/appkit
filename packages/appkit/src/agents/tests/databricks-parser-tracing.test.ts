import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { parseTextToolCalls } from "../databricks";

beforeAll(() => {
  context.disable();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => context.disable());

async function captureParse(source: string) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  vi.spyOn(trace, "getTracer").mockImplementation((name, version) =>
    provider.getTracer(name, version),
  );
  const result = parseTextToolCalls(source);
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  await provider.shutdown();
  return { result, spans };
}

test("traces a valid correctness-changing text tool parse with bounded source and result", async () => {
  const { result, spans } = await captureParse(
    '[{"name":"analytics.query","parameters":{"sql":"SELECT 1"}}]',
  );

  expect(result).toEqual([
    { name: "analytics.query", args: { sql: "SELECT 1" } },
  ]);
  expect(spans).toHaveLength(1);
  expect(spans[0].attributes).toMatchObject({
    "mlflow.spanType": "PARSER",
    "appkit.parser.source": "databricks.text_tool_calls",
    "mlflow.spanInputs":
      '{"source":"[{\\"name\\":\\"analytics.query\\",\\"parameters\\":{\\"sql\\":\\"SELECT 1\\"}}]"}',
    "mlflow.spanOutputs":
      '[{"args":{"sql":"SELECT 1"},"name":"analytics.query"}]',
    "appkit.parser.validation_error": false,
  });
  expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  expect(
    spans[0].duration[0] * 1_000 + spans[0].duration[1] / 1_000_000,
  ).toBeGreaterThanOrEqual(0);
});

test("finalizes malformed tool-like text as a bounded parser failure", async () => {
  const source = `[{"name":"analytics.query","parameters":{"secret":"${"x".repeat(80_000)}"}`;
  const { result, spans } = await captureParse(source);

  expect(result).toEqual([]);
  expect(spans).toHaveLength(1);
  const span = spans[0];
  expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(span.attributes["appkit.parser.validation_error"]).toBe(true);
  expect(span.attributes["mlflow.spanInputs.truncated"]).toBe(true);
  expect(span.attributes["mlflow.spanOutputs"]).toBe(
    '{"error":"[REDACTED]","partial_output":{"available":false,"reason":"no output produced"}}',
  );
});
