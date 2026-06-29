import { describe, expect, test } from "vitest";
import { buildAssessments } from "../mlflow-report";
import type { EvalResult } from "../types";

describe("buildAssessments", () => {
  test("emits one feedback per assertion plus an overall appkit_eval", () => {
    const result: EvalResult = {
      id: "support/weather",
      traceId: "tr-123",
      assertions: [
        { label: "succeeded", severity: "gate", pass: true },
        {
          label: "judge.closedQA",
          severity: "soft",
          pass: true,
          score: 0.9,
          detail: "clearly relevant",
        },
      ],
      passed: true,
    };
    const out = buildAssessments(result);
    expect(out.map((a) => a.assessment_name)).toEqual([
      "succeeded",
      "judge_closedQA",
      "appkit_eval",
    ]);

    const judge = out.find((a) => a.assessment_name === "judge_closedQA");
    expect(judge?.source.source_type).toBe("LLM_JUDGE");
    expect(judge?.feedback.value).toBe(0.9); // numeric score, not boolean
    expect(judge?.rationale).toBe("clearly relevant");

    const succeeded = out.find((a) => a.assessment_name === "succeeded");
    expect(succeeded?.source.source_type).toBe("CODE");
    expect(succeeded?.feedback.value).toBe(true);

    const overall = out.find((a) => a.assessment_name === "appkit_eval");
    expect(overall?.feedback.value).toBe(true);
  });

  test("sanitizes and de-duplicates assertion names", () => {
    const out = buildAssessments({
      id: "x",
      traceId: "tr-1",
      assertions: [
        { label: "calledTool(get_weather)", severity: "gate", pass: true },
        { label: "check", severity: "gate", pass: true },
        { label: "check", severity: "gate", pass: true },
      ],
      passed: true,
    });
    const names = out.map((a) => a.assessment_name);
    expect(names).toContain("calledTool_get_weather_");
    expect(names).toContain("check");
    expect(names).toContain("check_2");
  });

  test("returns [] without a trace id or when skipped", () => {
    expect(buildAssessments({ id: "x", assertions: [], passed: true })).toEqual(
      [],
    );
    expect(
      buildAssessments({
        id: "x",
        traceId: "tr-1",
        assertions: [],
        passed: true,
        skipped: { reason: "no data" },
      }),
    ).toEqual([]);
  });
});
