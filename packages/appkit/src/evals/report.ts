import type { EvalResult } from "./types";

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** True when no eval failed (skips don't count as failures). */
  allPassed: boolean;
}

export function summarize(results: EvalResult[]): EvalSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.skipped) skipped++;
    else if (r.passed) passed++;
    else failed++;
  }
  return {
    total: results.length,
    passed,
    failed,
    skipped,
    allPassed: failed === 0,
  };
}

/** Status glyph for a single eval result. */
export function evalGlyph(result: EvalResult): string {
  if (result.skipped) return "−";
  return result.passed ? "✓" : "✗";
}

/** The one-line header for a single eval result (no failure detail). */
export function formatEvalHeadline(result: EvalResult): string {
  if (result.skipped) {
    return `− ${result.id} (skipped${
      result.skipped.reason ? `: ${result.skipped.reason}` : ""
    })`;
  }
  return `${evalGlyph(result)} ${result.id}${
    result.description ? ` — ${result.description}` : ""
  }`;
}

/** Indented detail lines for a failing eval (error + failing assertions). */
export function formatEvalDetail(result: EvalResult): string[] {
  const lines: string[] = [];
  if (result.error) lines.push(`    error: ${result.error}`);
  for (const a of result.assertions) {
    if (a.pass) continue;
    const tag = a.severity === "soft" ? "soft" : "gate";
    lines.push(`    ✗ [${tag}] ${a.label}${a.detail ? ` — ${a.detail}` : ""}`);
  }
  return lines;
}

/** The final PASS/FAIL summary line. */
export function formatSummaryLine(results: EvalResult[]): string {
  const s = summarize(results);
  return `${s.allPassed ? "PASS" : "FAIL"} — ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (${s.total} total)`;
}

/** Render all results as a human-readable console report (non-streaming). */
export function formatEvalResults(results: EvalResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(formatEvalHeadline(r));
    lines.push(...formatEvalDetail(r));
  }
  lines.push("");
  lines.push(formatSummaryLine(results));
  return lines.join("\n");
}
