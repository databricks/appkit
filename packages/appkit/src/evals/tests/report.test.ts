import { describe, expect, test } from "vitest";
import {
  formatEvalResults,
  formatResultsJson,
  formatResultsJUnit,
  summarize,
} from "../report";
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

  test("formatResultsJson round-trips summary and result fields", () => {
    const parsed = JSON.parse(formatResultsJson(results));
    expect(parsed.summary).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      allPassed: false,
      passRate: 0.5,
    });
    expect(parsed.results).toHaveLength(3);
    const fail = parsed.results.find((r: EvalResult) => r.id === "a/fail");
    expect(fail.passed).toBe(false);
    expect(fail.assertions).toEqual([
      {
        label: "calledTool(x)",
        severity: "gate",
        pass: false,
        detail: "not called",
      },
    ]);
    const skip = parsed.results.find((r: EvalResult) => r.id === "a/skip");
    expect(skip.skipped).toEqual({ reason: "no data" });
  });

  test("formatResultsJson round-trips a result's error field", () => {
    const errored: EvalResult[] = [
      {
        id: "a/threw",
        assertions: [],
        passed: false,
        error: "boom: turn failed",
      },
    ];
    const parsed = JSON.parse(formatResultsJson(errored));
    expect(parsed.results[0].error).toBe("boom: turn failed");
    expect(parsed.summary.failed).toBe(1);
  });

  test("formatResultsJUnit emits suite counts, failure, skipped, and escapes special chars", () => {
    const withSpecial: EvalResult[] = [
      ...results,
      {
        id: 'a/b<x> & "q"',
        assertions: [
          {
            label: "check",
            severity: "gate",
            pass: false,
            detail: 'reply had <tag> & "quote"',
          },
        ],
        passed: false,
      },
    ];
    const xml = formatResultsJUnit(withSpecial);
    expect(xml).toContain(
      '<testsuite name="appkit-agent-evals" tests="4" failures="2" skipped="1">',
    );
    expect(xml).toContain('<testcase name="a/pass" classname="agent-eval"/>');
    expect(xml).toContain("<failure");
    expect(xml).toContain("<skipped");
    // Special chars are escaped in both the id attribute and the failure message.
    expect(xml).toContain("a/b&lt;x&gt; &amp; &quot;q&quot;");
    expect(xml).toContain("reply had &lt;tag&gt; &amp; &quot;quote&quot;");
    // Raw unescaped special chars from the id/detail must not leak through.
    expect(xml).not.toContain("a/b<x>");
  });
});
