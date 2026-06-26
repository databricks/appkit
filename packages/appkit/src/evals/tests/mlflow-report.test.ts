import { describe, expect, test } from "vitest";
import { buildAssessment } from "../mlflow-report";
import type { EvalResult } from "../types";

describe("buildAssessment", () => {
  test("builds a pass assessment with trace id and source", () => {
    const result: EvalResult = {
      id: "support/weather",
      traceId: "tr-123",
      assertions: [{ label: "succeeded", severity: "gate", pass: true }],
      passed: true,
    };
    const a = buildAssessment(result);
    expect(a).toEqual({
      trace_id: "tr-123",
      assessment_name: "appkit_eval",
      source: { source_type: "CODE", source_id: "appkit-eval" },
      feedback: { value: true },
      rationale: "all assertions passed",
      metadata: { eval_id: "support/weather" },
    });
  });

  test("fail assessment summarizes failing assertions in the rationale", () => {
    const a = buildAssessment({
      id: "support/x",
      traceId: "tr-9",
      assertions: [
        { label: "succeeded", severity: "gate", pass: true },
        {
          label: "calledTool(get_weather)",
          severity: "gate",
          pass: false,
          detail: "not called",
        },
      ],
      passed: false,
    });
    expect(a?.feedback.value).toBe(false);
    expect(a?.rationale).toContain("gate:calledTool(get_weather) (not called)");
  });

  test("returns undefined without a trace id or when skipped", () => {
    expect(
      buildAssessment({ id: "x", assertions: [], passed: true }),
    ).toBeUndefined();
    expect(
      buildAssessment({
        id: "x",
        traceId: "tr-1",
        assertions: [],
        passed: true,
        skipped: { reason: "no data" },
      }),
    ).toBeUndefined();
  });
});
