import { describe, expect, test } from "vitest";
import { isJudgeConfigured, toJudgeScore } from "../judge";

describe("judge score mapping", () => {
  test("toJudgeScore reads score and rationale from an autoevals Score", () => {
    expect(
      toJudgeScore({ score: 0.8, metadata: { rationale: "mostly correct" } }),
    ).toEqual({ score: 0.8, rationale: "mostly correct" });
  });

  test("toJudgeScore defaults a missing/null score to 0 and omits rationale", () => {
    expect(toJudgeScore({ score: null })).toEqual({ score: 0 });
    expect(toJudgeScore({})).toEqual({ score: 0 });
    expect(toJudgeScore({ score: 1, metadata: { rationale: 42 } })).toEqual({
      score: 1,
    });
  });

  test("judging is disabled until configured", () => {
    expect(isJudgeConfigured()).toBe(false);
  });
});
