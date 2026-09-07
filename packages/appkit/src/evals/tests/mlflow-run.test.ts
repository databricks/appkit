import { describe, expect, test } from "vitest";

import { aggregateMetrics } from "../mlflow-run";
import type { EvalResult } from "../types";

describe("aggregateMetrics", () => {
  test("counts total/scored/passed and computes pass_rate (skips excluded)", () => {
    const results: EvalResult[] = [
      { id: "a", assertions: [], passed: true },
      { id: "b", assertions: [], passed: false },
      { id: "c", assertions: [], passed: true, skipped: { reason: "x" } },
    ];
    const metrics = aggregateMetrics(results, 1000);
    const byKey = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(byKey["eval/total"]).toBe(3);
    expect(byKey["eval/scored"]).toBe(2);
    expect(byKey["eval/passed"]).toBe(1);
    expect(byKey["eval/pass_rate"]).toBe(0.5);
    expect(metrics.every((m) => m.timestamp === 1000 && m.step === 0)).toBe(
      true,
    );
  });

  test("pass_rate is 0 when nothing is scored", () => {
    const metrics = aggregateMetrics(
      [{ id: "a", assertions: [], passed: true, skipped: {} }],
      1,
    );
    expect(metrics.find((m) => m.key === "eval/pass_rate")?.value).toBe(0);
  });
});
