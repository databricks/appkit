/**
 * Rendering for `appkit doctor` — turns a {@link DoctorReport} into either a
 * human-readable console report or JSON, matching the `--json` convention used
 * by `plugin list` / `plugin validate`.
 */

import type { CheckStatus, DoctorReport } from "./types";

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

export function printReport(report: DoctorReport): void {
  const { auth, resources, summary } = report;

  console.log("");
  console.log("Databricks AppKit — connection check");
  if (auth.profile) console.log(`  profile   ${auth.profile}`);
  if (auth.host) console.log(`  workspace ${auth.host}`);
  console.log("");

  console.log(`${glyph(auth.status)} Auth   ${auth.detail ?? auth.status}`);
  if (auth.hint) console.log(`          hint: ${auth.hint}`);
  console.log("");

  if (resources.length === 0) {
    console.log("No resources declared.");
  } else {
    console.log("Resources");
    const ordered = [...resources].sort(
      (a, b) => DISPLAY_ORDER[a.status] - DISPLAY_ORDER[b.status],
    );
    for (const r of ordered) {
      const { target } = r;
      // Only attribute plugin · type on rows that need fixing.
      const suffix =
        r.status !== "ok" ? `   ${target.plugin} · ${target.type}` : "";
      console.log(`  ${glyph(r.status)}  ${target.alias}${suffix}`);
      for (const layer of r.layers) {
        if (layer.status === "ok") continue;
        if (layer.detail) console.log(`        ↳ ${layer.detail}`);
        if (layer.hint) console.log(`          hint: ${layer.hint}`);
      }
    }
  }
  console.log("");

  // Fold auth failure into the counts so it doesn't read as "0 errors".
  const authError = auth.status === "error" ? 1 : 0;
  console.log(summaryLine({ ...summary, error: summary.error + authError }));
  if (authError) {
    console.log("Fix authentication first, then re-run to check resources.");
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
