import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as approvalGateModule from "../tool-approval-gate";
import { ToolApprovalGate } from "../tool-approval-gate";

async function captureSpans(
  operation: () => Promise<unknown>,
): Promise<{ spans: ReadableSpan[]; error?: unknown }> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const getTracerSpy = vi
    .spyOn(trace, "getTracer")
    .mockImplementation((name: string, version?: string) =>
      provider.getTracer(name, version),
    );
  let error: unknown;
  let spans: ReadableSpan[] = [];
  try {
    await operation();
  } catch (caught) {
    error = caught;
  } finally {
    // The SDK's flush/shutdown path uses timers internally. Approval tests use
    // fake timers for deterministic wait-state transitions, so restore real
    // timers only after the operation (and its measured duration) completes.
    vi.useRealTimers();
    await provider.forceFlush();
    spans = exporter.getFinishedSpans();
    getTracerSpy.mockRestore();
    await provider.shutdown();
  }
  return { spans, ...(error !== undefined ? { error } : {}) };
}

function tracedWait(
  gate: ToolApprovalGate,
  input: {
    approvalId: string;
    streamId: string;
    userId: string;
    timeoutMs: number;
    toolName: string;
    effect?: "read" | "write" | "update" | "destructive";
    args: unknown;
  },
): Promise<"approve" | "deny"> {
  return gate.wait(input as unknown as Parameters<ToolApprovalGate["wait"]>[0]);
}

function approvalSpan(spans: ReadableSpan[]): ReadableSpan {
  const span = spans.find(
    (candidate) => candidate.attributes["mlflow.spanType"] === "CHAIN",
  );
  expect(span, "missing CHAIN span").toBeDefined();
  return span as ReadableSpan;
}

describe("ToolApprovalGate", () => {
  let gate: ToolApprovalGate;

  beforeEach(() => {
    vi.useFakeTimers();
    gate = new ToolApprovalGate();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves with 'approve' when a matching submit arrives", async () => {
    const waiter = gate.wait({
      approvalId: "a1",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    expect(gate.size).toBe(1);

    const result = gate.submit({
      approvalId: "a1",
      userId: "alice",
      decision: "approve",
    });

    expect(result).toEqual({ ok: true });
    await expect(waiter).resolves.toBe("approve");
    expect(gate.size).toBe(0);
  });

  test("resolves with 'deny' on explicit deny", async () => {
    const waiter = gate.wait({
      approvalId: "a2",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    gate.submit({
      approvalId: "a2",
      userId: "alice",
      decision: "deny",
    });
    await expect(waiter).resolves.toBe("deny");
  });

  test("auto-denies after timeoutMs with no submit", async () => {
    const waiter = gate.wait({
      approvalId: "a3",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 1000,
    });
    vi.advanceTimersByTime(1000);
    await expect(waiter).resolves.toBe("deny");
    expect(gate.size).toBe(0);
  });

  test("refuses a submit from a different user (ownership check)", async () => {
    const waiter = gate.wait({
      approvalId: "a4",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const result = gate.submit({
      approvalId: "a4",
      userId: "bob",
      decision: "approve",
    });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(gate.size).toBe(1);
    // Waiter is still pending; cleanup to let fake timers drain.
    gate.submit({
      approvalId: "a4",
      userId: "alice",
      decision: "deny",
    });
    await expect(waiter).resolves.toBe("deny");
  });

  test("returns 'unknown' reason when approvalId is not registered", () => {
    expect(
      gate.submit({ approvalId: "nope", userId: "x", decision: "approve" }),
    ).toEqual({ ok: false, reason: "unknown" });
  });

  test("abortStream denies every pending gate for that stream", async () => {
    const a = gate.wait({
      approvalId: "a5",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const b = gate.wait({
      approvalId: "a6",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const c = gate.wait({
      approvalId: "a7",
      streamId: "s2",
      userId: "alice",
      timeoutMs: 60_000,
    });
    gate.abortStream("s1");
    await expect(a).resolves.toBe("deny");
    await expect(b).resolves.toBe("deny");
    expect(gate.size).toBe(1);
    // s2's waiter is still pending; settle it to clean up timers.
    gate.submit({ approvalId: "a7", userId: "alice", decision: "deny" });
    await expect(c).resolves.toBe("deny");
  });

  test("abortAll denies every pending gate", async () => {
    const a = gate.wait({
      approvalId: "a8",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 60_000,
    });
    const b = gate.wait({
      approvalId: "a9",
      streamId: "s2",
      userId: "bob",
      timeoutMs: 60_000,
    });
    gate.abortAll();
    await expect(a).resolves.toBe("deny");
    await expect(b).resolves.toBe("deny");
    expect(gate.size).toBe(0);
  });

  test("a timed-out approval cannot be resolved by a late submit", async () => {
    const waiter = gate.wait({
      approvalId: "a10",
      streamId: "s1",
      userId: "alice",
      timeoutMs: 500,
    });
    vi.advanceTimersByTime(500);
    await expect(waiter).resolves.toBe("deny");

    const late = gate.submit({
      approvalId: "a10",
      userId: "alice",
      decision: "approve",
    });
    expect(late).toEqual({ ok: false, reason: "unknown" });
  });

  describe("semantic CHAIN spans", () => {
    beforeEach(() => {
      // The OpenTelemetry SDK's in-memory processor uses timers internally;
      // approval state remains deterministic with a 1ms real timeout here.
      vi.useRealTimers();
    });

    test.each([
      ["approve", "approved"],
      ["deny", "denied"],
    ] as const)(
      "records an explicit %s decision as %s",
      async (decision, expectedState) => {
        const observed = await captureSpans(async () => {
          const waiter = tracedWait(gate, {
            approvalId: `explicit-${decision}`,
            streamId: "stream-explicit",
            userId: "alice",
            timeoutMs: 60_000,
            toolName: "users.update",
            effect: "update",
            args: { password: "do-not-log", userId: 7 },
          });
          gate.submit({
            approvalId: `explicit-${decision}`,
            userId: "alice",
            decision,
          });
          await expect(waiter).resolves.toBe(decision);
        });

        expect(observed.error).toBeUndefined();
        const span = approvalSpan(observed.spans);
        expect(span.attributes).toMatchObject({
          "appkit.approval.id": `explicit-${decision}`,
          "appkit.tool.name": "users.update",
          "appkit.approval.effect": "update",
          "appkit.approval.decision": decision,
          "appkit.approval.state": expectedState,
          "appkit.approval.duration_ms": expect.any(Number),
        });
        expect(
          JSON.parse(String(span.attributes["mlflow.spanInputs"])),
        ).toEqual({
          password: "[REDACTED]",
          userId: 7,
        });
        expect(JSON.parse(String(span.attributes["mlflow.spanOutputs"]))).toBe(
          decision,
        );
        expect(span.status.code).toBe(SpanStatusCode.OK);
      },
    );

    test("records automatic denial as timed_out", async () => {
      const observed = await captureSpans(async () => {
        const waiter = tracedWait(gate, {
          approvalId: "timeout-1",
          streamId: "stream-timeout",
          userId: "alice",
          timeoutMs: 1,
          toolName: "users.delete",
          effect: "destructive",
          args: { userId: 8 },
        });
        await expect(waiter).resolves.toBe("deny");
      });

      expect(observed.error).toBeUndefined();
      expect(approvalSpan(observed.spans).attributes).toMatchObject({
        "appkit.approval.decision": "deny",
        "appkit.approval.state": "timed_out",
        "appkit.approval.duration_ms": expect.any(Number),
      });
    });

    test("records stream abort as cancelled", async () => {
      const observed = await captureSpans(async () => {
        const waiter = tracedWait(gate, {
          approvalId: "cancel-1",
          streamId: "stream-cancel",
          userId: "alice",
          timeoutMs: 60_000,
          toolName: "users.delete",
          effect: "destructive",
          args: { userId: 9 },
        });
        gate.abortStream("stream-cancel");
        await expect(waiter).resolves.toBe("deny");
      });

      expect(observed.error).toBeUndefined();
      expect(approvalSpan(observed.spans).attributes).toMatchObject({
        "appkit.approval.decision": "deny",
        "appkit.approval.state": "cancelled",
        "appkit.approval.duration_ms": expect.any(Number),
      });
    });

    test("traceApprovalWait records a sanitized failed state", async () => {
      type TraceApprovalWait = <T>(
        input: {
          approvalId: string;
          toolName: string;
          effect?: "read" | "write" | "update" | "destructive";
          args: unknown;
        },
        operation: (span: Span) => Promise<T>,
      ) => Promise<T>;
      const traceApprovalWait = (
        approvalGateModule as unknown as {
          traceApprovalWait?: TraceApprovalWait;
        }
      ).traceApprovalWait;

      const observed = await captureSpans(() =>
        traceApprovalWait
          ? traceApprovalWait(
              {
                approvalId: "failed-1",
                toolName: "users.delete",
                effect: "destructive",
                args: {},
              },
              async () => {
                throw new Error("approval backend token secret-token");
              },
            )
          : Promise.reject(new Error("traceApprovalWait is not implemented")),
      );

      expect(observed.error).toBeInstanceOf(Error);
      const span = approvalSpan(observed.spans);
      expect(span.attributes).toMatchObject({
        "appkit.approval.id": "failed-1",
        "appkit.approval.decision": "error",
        "appkit.approval.state": "failed",
        "appkit.error": '{"error":"[REDACTED]"}',
        "appkit.approval.duration_ms": expect.any(Number),
      });
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(
        JSON.stringify({ attributes: span.attributes, events: span.events }),
      ).not.toContain("secret-token");
    });
  });
});
