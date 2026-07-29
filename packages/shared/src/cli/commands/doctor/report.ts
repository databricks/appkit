/**
 * Rendering for `appkit doctor` — turns a {@link DoctorReport} into either a
 * human-readable console report or JSON, matching the `--json` convention used
 * by `plugin list` / `plugin validate`.
 */

import type { CheckStatus, DoctorReport, ResourceCheckResult } from "./types";

/**
 * True when a resource's *only* finding is that its existence probe was skipped
 * because auth failed — i.e. it has no independent problem worth its own row.
 * Such rows are collapsed into one summary line.
 */
function isOnlyAuthSkipped(r: ResourceCheckResult): boolean {
  if (r.status !== "skipped") return false;
  const hasAuthSkip = r.layers.some(
    (l) => l.layer === "existence" && l.code === "AUTH_UNAVAILABLE",
  );
  if (!hasAuthSkip) return false;
  // Collapse only when auth-skip is the *sole* finding — any other non-ok layer
  // (e.g. a missing env var) is actionable and keeps the row on its own line.
  return r.layers.every(
    (l) =>
      l.status === "ok" ||
      (l.layer === "existence" && l.code === "AUTH_UNAVAILABLE"),
  );
}

/** Left-pads every line of `text` by `spaces`, for indented detail blocks. */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => `${pad}${l}`)
    .join("\n");
}

function glyph(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return "✓";
    case "warn":
      return "⚠";
    case "error":
      return "✗";
    default:
      return "•";
  }
}

/** Row display order: most severe first (stable within a status). */
const DISPLAY_ORDER: Record<CheckStatus, number> = {
  error: 0,
  warn: 1,
  skipped: 2,
  ok: 3,
};

/** Shows only the non-zero categories. */
function summaryLine(counts: {
  ok: number;
  warn: number;
  error: number;
  skipped: number;
}): string {
  const parts: string[] = [];
  if (counts.error)
    parts.push(`${counts.error} error${counts.error > 1 ? "s" : ""}`);
  if (counts.warn)
    parts.push(`${counts.warn} warning${counts.warn > 1 ? "s" : ""}`);
  if (counts.ok) parts.push(`${counts.ok} ok`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  return parts.length > 0 ? parts.join(", ") : "nothing to check";
}

export function printReport(report: DoctorReport, detail = false): void {
  const { auth, resources, summary } = report;

  console.log("");
  console.log("Databricks AppKit — connection check");
  if (auth.profile) console.log(`  profile   ${auth.profile}`);
  if (auth.host) console.log(`  workspace ${auth.host}`);
  console.log("");

  console.log(`${glyph(auth.status)} Auth   ${auth.detail ?? auth.status}`);
  if (auth.hint) console.log(`\n  Hint: ${auth.hint}`);
  // The full underlying error is hidden by default (the hint explains the fix);
  // `--detail` surfaces it for debugging.
  if (detail && auth.raw) {
    console.log(`\n  Details:\n${indent(auth.raw, 4)}`);
  }
  console.log("");

  if (resources.length === 0) {
    console.log("No resources declared.");
  } else {
    console.log("Resources");
    const ordered = [...resources].sort(
      (a, b) => DISPLAY_ORDER[a.status] - DISPLAY_ORDER[b.status],
    );
    // When auth failed, every resource's existence probe is auth-skipped. Those
    // rows carry no new information, so collapse the ones with no *other*
    // finding into a single line — but keep any that also have a real problem
    // (e.g. a missing env var), which is actionable regardless of auth.
    const authSkipped = ordered.filter(isOnlyAuthSkipped);
    const shown = ordered.filter((r) => !isOnlyAuthSkipped(r));

    for (const r of shown) {
      const { target } = r;
      // Only attribute plugin · type on rows that need fixing.
      const suffix =
        r.status !== "ok" ? `   ${target.plugin} · ${target.type}` : "";
      console.log(`  ${glyph(r.status)}  ${target.alias}${suffix}`);
      for (const layer of r.layers) {
        if (layer.status === "ok") continue;
        if (layer.detail) console.log(`        ↳ ${layer.detail}`);
        if (layer.hint) console.log(`          Hint: ${layer.hint}`);
      }
    }

    if (authSkipped.length > 0) {
      console.log(
        `  •  ${authSkipped.length} resource${authSkipped.length > 1 ? "s" : ""} not checked (auth failed)`,
      );
    }
  }
  console.log("");

  // Fold auth failure into the counts so it doesn't read as "0 errors".
  const authError = auth.status === "error" ? 1 : 0;
  console.log(summaryLine({ ...summary, error: summary.error + authError }));
  // Point at --detail when there's more to show and it wasn't requested.
  if (!detail && auth.raw) {
    console.log("\nRun with --detail for full error output.");
  }
  console.log("");
}

export function printReportJson(report: DoctorReport): void {
  console.log(JSON.stringify(report, null, 2));
}

/** Non-zero if auth or any resource errored, so `appkit doctor` can gate CI. */
export function exitCodeFor(report: DoctorReport): number {
  if (report.auth.status === "error") return 1;
  return report.summary.error > 0 ? 1 : 0;
}
