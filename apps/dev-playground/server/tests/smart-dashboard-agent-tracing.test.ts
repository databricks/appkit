import { describe, expect, test } from "vitest";
import { runSmartDashboardTracingFixture } from "./smart-dashboard-agent-tracing.fixture";

describe("Smart Dashboard semantic tracing fixture", () => {
  test("emits the exact query → delegation → pilot → action tree", async () => {
    const observed = await runSmartDashboardTracingFixture();
    const root = observed.spans.find(
      (span) => span.spanType === "AGENT" && span.agentName === "query",
    );
    const delegation = observed.spans.find(
      (span) =>
        span.spanType === "TOOL" && span.toolName === "agent-dashboard_pilot",
    );
    const pilot = observed.spans.find(
      (span) =>
        span.spanType === "AGENT" && span.agentName === "dashboard_pilot",
    );
    const action = observed.spans.find(
      (span) =>
        span.spanType === "TOOL" && span.toolName === "filter_by_date_range",
    );

    expect(
      observed.spans.filter(
        (span) => span.spanType === "AGENT" && span.parentSpanId === undefined,
      ),
    ).toHaveLength(1);
    expect(root).toBeDefined();
    expect(delegation?.parentSpanId).toBe(root?.spanId);
    expect(pilot?.parentSpanId).toBe(delegation?.spanId);
    expect(action?.parentSpanId).toBe(pilot?.spanId);
    expect(new Set(observed.spans.map((span) => span.traceId))).toEqual(
      new Set([observed.traceId]),
    );
    expect(observed.events[0]).toMatchObject({
      type: "appkit.metadata",
      data: { traceId: observed.traceId },
    });
  });
});
