import { describe, expect, test } from "vitest";
import {
  type AgentModelEndEvent,
  type AgentModelStartEvent,
  type AgentRemoteTraceEvent,
  type AgentUsage,
  AgentUsageAccumulator,
  captureTraceValue,
} from "../../../beta";

describe("agent tracing public API", () => {
  test("requires spanId for linked remote traces", () => {
    // @ts-expect-error linked remote traces require a spanId
    const invalidLinkedTrace: AgentRemoteTraceEvent = {
      type: "remote_trace",
      traceId: "abcdef0123456789abcdef0123456789",
      source: "model-serving",
      relation: "linked",
    };

    expect(invalidLinkedTrace.relation).toBe("linked");
  });

  test("exposes lifecycle, capture, and usage primitives from the beta entrypoint", () => {
    const usage: AgentUsage = {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      costAvailable: false,
    };
    const lifecycle: [
      AgentModelStartEvent,
      AgentModelEndEvent,
      AgentRemoteTraceEvent,
    ] = [
      {
        type: "model_start",
        stepId: "step-1",
        model: "model-a",
        provider: "databricks",
        input: "hello",
        startedAt: 100,
      },
      {
        type: "model_end",
        stepId: "step-1",
        model: "model-a",
        provider: "databricks",
        output: "world",
        usage,
        streamDurationMs: 20,
        endedAt: 120,
      },
      {
        type: "remote_trace",
        traceId: "abcdef0123456789abcdef0123456789",
        spanId: "0123456789abcdef",
        source: "model-serving",
        relation: "linked",
      },
    ];
    const accumulator = new AgentUsageAccumulator();
    accumulator.add(usage);

    expect(lifecycle.map((event) => event.type)).toEqual([
      "model_start",
      "model_end",
      "remote_trace",
    ]);
    expect(captureTraceValue({ token: "secret" }).value).toBe(
      '{"token":"[REDACTED]"}',
    );
    expect(accumulator.snapshot()).toEqual(usage);
  });
});
