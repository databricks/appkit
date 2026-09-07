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
  test("summarize counts pass/fail/skip and allPassed", () => {
    expect(summarize(results)).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      allPassed: false,
    });
  });

  test("summarize allPassed is true when nothing failed", () => {
    expect(summarize([results[0], results[2]]).allPassed).toBe(true);
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
