import { describe, expect, test } from "vitest";
import { formatEvalResults, summarize } from "../report";
import type { EvalResult } from "../types";

const results: EvalResult[] = [
  {
    id: "a/pass",
    assertions: [{ label: "succeeded", severity: "gate", pass: true }],
    passed: true,
  },
  {
    id: "a/fail",
    assertions: [
      {
        label: "calledTool(x)",
        severity: "gate",
        pass: false,
        detail: "not called",
      },
    ],
    passed: false,
  },
  {
    id: "a/skip",
    assertions: [],
    passed: true,
    skipped: { reason: "no data" },
  },
];

describe("eval reporting", () => {
  test("summarize counts pass/fail/skip, allPassed, and passRate", () => {
    expect(summarize(results)).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      allPassed: false,
      passRate: 0.5, // 1 passed of 2 scored; the skip is excluded
    });
  });

  test("summarize allPassed is true and passRate is 1 when nothing failed", () => {
    const s = summarize([results[0], results[2]]);
    expect(s.allPassed).toBe(true);
    expect(s.passRate).toBe(1); // 1 passed of 1 scored (skip excluded)
  });

  test("passRate is 1 when every eval was skipped (nothing scored)", () => {
    expect(summarize([results[2]]).passRate).toBe(1);
  });

  test("formatEvalResults shows status, failing assertions, and a summary line", () => {
    const out = formatEvalResults(results);
    expect(out).toContain("✓ a/pass");
    expect(out).toContain("✗ a/fail");
    expect(out).toContain("[gate] calledTool(x) — not called");
    expect(out).toContain("a/skip (skipped: no data)");
    expect(out).toContain("FAIL — 1 passed, 1 failed, 1 skipped (3 total)");
  });
});
