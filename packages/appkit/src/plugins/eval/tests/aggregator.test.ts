import { describe, expect, test } from "vitest";
import {
  aggregateResults,
  computeAppeval100,
  computeAppedit100,
} from "../aggregator";

describe("computeAppeval100", () => {
  test("returns 1.0 when all checks pass", () => {
    const score = computeAppeval100({
      buildSuccess: true,
      unitTestsPass: true,
      smokeTestsPass: true,
      typeSafetyPass: true,
      localRunability: 1.0,
      appsValidatePass: true,
    });
    expect(score).toBeCloseTo(1.0);
  });

  test("returns 0.0 when all checks fail", () => {
    const score = computeAppeval100({
      buildSuccess: false,
      unitTestsPass: false,
      smokeTestsPass: false,
      typeSafetyPass: false,
      localRunability: 0.0,
      appsValidatePass: false,
    });
    expect(score).toBeCloseTo(0.0);
  });

  test("returns ~0.5 when half pass", () => {
    const score = computeAppeval100({
      buildSuccess: true,
      unitTestsPass: true,
      smokeTestsPass: true,
      typeSafetyPass: false,
      localRunability: 0.0,
      appsValidatePass: false,
    });
    expect(score).toBeCloseTo(0.5);
  });

  test("handles partial runability", () => {
    const score = computeAppeval100({
      buildSuccess: true,
      unitTestsPass: false,
      smokeTestsPass: false,
      typeSafetyPass: false,
      localRunability: 0.5,
      appsValidatePass: false,
    });
    // (1 + 0 + 0 + 0 + 0.5 + 0) / 6 = 0.25
    expect(score).toBeCloseTo(0.25);
  });
});

describe("computeAppedit100", () => {
  test("returns 1.0 with no regressions", () => {
    expect(computeAppedit100(10, 0, 0)).toBeCloseTo(1.0);
  });

  test("returns 0 with no edits", () => {
    expect(computeAppedit100(0, 0, 0)).toBe(0);
  });

  test("correctly accounts for regressions", () => {
    // 10 edits, 2 build regressions, 1 test regression = (10-3)/10 = 0.7
    expect(computeAppedit100(10, 2, 1)).toBeCloseTo(0.7);
  });
});

describe("aggregateResults", () => {
  test("deduplicates by normalized app name, keeps highest score", () => {
    const results = [
      {
        appName: "my-app",
        appDir: "/a",
        issues: [],
        appkitVersion: "0.20",
        tags: "test",
        metrics: { appeval100: 0.5, buildSuccess: true } as any,
      },
      {
        appName: "my_app",
        appDir: "/b",
        issues: [],
        appkitVersion: "0.20",
        tags: "test",
        metrics: { appeval100: 0.8, buildSuccess: true } as any,
      },
    ] as any[];

    const agg = aggregateResults(results, [], 2, 2);
    expect(agg.totalApps).toBe(1); // deduplicated
    expect(agg.avgAppeval100).toBeCloseTo(0.8); // kept higher score
  });

  test("computes generation cost metrics", () => {
    const results = [
      {
        appName: "app1",
        appDir: "/a",
        issues: [],
        appkitVersion: "0.20",
        tags: "test",
        metrics: { appeval100: 0.9 } as any,
        generationMetrics: {
          costUsd: 0.02,
          inputTokens: 1000n,
          outputTokens: 500n,
          turns: 5,
          generationTimeSec: 60,
        } as any,
      },
      {
        appName: "app2",
        appDir: "/b",
        issues: [],
        appkitVersion: "0.20",
        tags: "test",
        metrics: { appeval100: 0.8 } as any,
        generationMetrics: {
          costUsd: 0.03,
          inputTokens: 2000n,
          outputTokens: 1000n,
          turns: 7,
          generationTimeSec: 90,
        } as any,
      },
    ] as any[];

    const agg = aggregateResults(results, [], 2, 2);
    expect(agg.totalGenCostUsd).toBeCloseTo(0.05);
    expect(agg.avgGenCostUsd).toBeCloseTo(0.025);
    expect(agg.avgGenTurns).toBeCloseTo(6);
    expect(Number(agg.totalGenTokens)).toBe(4500);
  });

  test("computes edit regression metrics", () => {
    const editResults = [
      {
        appName: "app1",
        editName: "add_emoji",
        issues: [],
        regression: {
          buildRegressed: true,
          testsRegressed: false,
          appevalDelta: -0.1,
          noChangesMade: false,
        },
        editMetrics: { costUsd: 0.01, turns: 3, editTimeSec: 30 },
      },
      {
        appName: "app2",
        editName: "simplify",
        issues: [],
        regression: {
          buildRegressed: false,
          testsRegressed: true,
          appevalDelta: -0.05,
          noChangesMade: false,
        },
        editMetrics: { costUsd: 0.02, turns: 5, editTimeSec: 45 },
      },
      {
        appName: "app3",
        editName: "fix_bug",
        issues: [],
        regression: {
          buildRegressed: false,
          testsRegressed: false,
          appevalDelta: 0.1,
          noChangesMade: false,
        },
        editMetrics: { costUsd: 0.015, turns: 4, editTimeSec: 35 },
      },
    ] as any[];

    const agg = aggregateResults([], editResults, 0, 0);
    expect(agg.totalEdits).toBe(3);
    expect(agg.editBuildRegressions).toBe(1);
    expect(agg.editTestRegressions).toBe(1);
    // appedit_100 = (3 - 1 - 1) / 3 = 0.333...
    expect(agg.appedit100).toBeCloseTo(1 / 3);
  });

  test("handles empty inputs", () => {
    const agg = aggregateResults([], [], 0, 0);
    expect(agg.totalApps).toBe(0);
    expect(agg.avgAppeval100).toBe(0);
    expect(agg.totalEdits).toBe(0);
    expect(agg.appedit100).toBe(0);
  });
});
