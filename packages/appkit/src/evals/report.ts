import type { EvalResult } from "./types";

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** True when no eval failed (skips don't count as failures). */
  allPassed: boolean;
  /** Fraction of scored (non-skipped) evals that passed, 0..1 (1 when none scored). */
  passRate: number;
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
  const scored = passed + failed;
  return {
    total: results.length,
    passed,
    failed,
    skipped,
    allPassed: failed === 0,
    passRate: scored === 0 ? 1 : passed / scored,
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

/**
 * Render results as a machine-readable JSON report (2-space indented):
 * `{ summary: EvalSummary, results: EvalResult[] }`. Faithful to the types —
 * every field present on a result round-trips.
 */
export function formatResultsJson(results: EvalResult[]): string {
  return JSON.stringify({ summary: summarize(results), results }, null, 2);
}

/** Escape a value for use in XML text/attribute content. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** One-line reason a result failed: its error, else its failing gate labels. */
function failureMessage(result: EvalResult): string {
  if (result.error) return result.error;
  const gates = result.assertions
    .filter((a) => !a.pass && a.severity === "gate")
    .map((a) => (a.detail ? `${a.label} — ${a.detail}` : a.label));
  return gates.length ? gates.join("; ") : "eval failed";
}

/**
 * Render results as JUnit XML for standard CI test reporters: a single
 * `<testsuite name="appkit-agent-evals">` with one `<testcase>` per result.
 * Failures carry a `<failure>` (error or failing-gate summary); skips a
 * `<skipped>`. All attribute/text values are XML-escaped.
 */
export function formatResultsJUnit(results: EvalResult[]): string {
  const s = summarize(results);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuite name="appkit-agent-evals" tests="${s.total}" failures="${s.failed}" skipped="${s.skipped}">`,
  );
  for (const r of results) {
    const open = `  <testcase name="${escapeXml(r.id)}" classname="agent-eval"`;
    if (r.skipped) {
      lines.push(`${open}>`);
      lines.push(
        r.skipped.reason
          ? `    <skipped message="${escapeXml(r.skipped.reason)}"/>`
          : "    <skipped/>",
      );
      lines.push("  </testcase>");
    } else if (!r.passed) {
      const message = failureMessage(r);
      lines.push(`${open}>`);
      lines.push(`    <failure message="${escapeXml(message)}"/>`);
      lines.push("  </testcase>");
    } else {
      lines.push(`${open}/>`);
    }
  }
  lines.push("</testsuite>");
  return lines.join("\n");
}
