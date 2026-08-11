import { describe, expect, test } from "vitest";
import { AgentUsageAccumulator } from "../usage";

describe("AgentUsageAccumulator", () => {
  test("returns zero usage with unavailable cost before any model steps", () => {
    expect(new AgentUsageAccumulator().snapshot()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costAvailable: false,
    });
  });

  test("sums token, cache, and cost usage across priced model steps", () => {
    const usage = new AgentUsageAccumulator();
    usage.add({
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
      cacheReadInputTokens: 4,
      costUsd: 0.02,
      costAvailable: true,
    });
    usage.add({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      cacheCreationInputTokens: 2,
      costUsd: 0.01,
      costAvailable: true,
    });

    expect(usage.snapshot()).toEqual({
      inputTokens: 14,
      outputTokens: 5,
      totalTokens: 19,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 2,
      costUsd: 0.03,
      costAvailable: true,
    });
  });

  test("omits partial aggregate cost when any model step is unpriced", () => {
    const usage = new AgentUsageAccumulator();
    usage.add({
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
      costUsd: 0.02,
      costAvailable: true,
    });
    usage.add({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      costAvailable: false,
    });

    expect(usage.snapshot()).toEqual({
      inputTokens: 14,
      outputTokens: 5,
      totalTokens: 19,
      costAvailable: false,
    });
  });

  test("omits cost when priced steps do not report a value", () => {
    const usage = new AgentUsageAccumulator();
    usage.add({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      costAvailable: true,
    });

    expect(usage.snapshot()).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      costAvailable: true,
    });
  });
});
