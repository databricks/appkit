import { describe, expect, test } from "vitest";

import type { MlflowClient } from "../../connectors/mlflow";
import {
  configureJudge,
  isJudgeConfigured,
  teardownJudge,
  toJudgeScore,
} from "../judge";

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

describe("judge env lifecycle", () => {
  test("sets the bearer for the run, then restores it on teardown", async () => {
    const before = process.env.OPENAI_API_KEY;
    const client = {
      servingEndpointsUrl: () => "https://host.example/serving-endpoints",
    } as unknown as MlflowClient;

    await configureJudge({ client, token: "secret-bearer", model: "judge" });
    // The bearer must be live in the env during the run (autoevals reads it).
    expect(process.env.OPENAI_API_KEY).toBe("secret-bearer");

    teardownJudge();
    // After the run it must not linger in process.env.
    expect(process.env.OPENAI_API_KEY).toBe(before);
    expect(isJudgeConfigured()).toBe(false);
  });
});
