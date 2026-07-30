/**
 * Rendering for `appkit doctor` — turns a {@link DoctorReport} into either a
 * human-readable console report or JSON, matching the `--json` convention used
 * by `plugin list` / `plugin validate`.
 *
 * Design goals: one flat, severity-sorted checklist (no titled sub-sections),
 * where every row shares the same shape — `glyph  label`, with detail and an
 * optional `Hint:` indented beneath, and expanded rows set apart by blank lines.
 * Show as little as possible on the happy path (a fine resource is just a green
 * tick and its name); reveal detail only where there's something to act on.
 * Colour is sparing and consistent — glyphs carry status (green/red/yellow),
 * and the actionable token (a quoted id / code span in cyan, an env var in bold)
 * is highlighted so it stands out from prose. picocolors auto-disables when
 * output isn't a TTY (and honours NO_COLOR), so piped/CI output stays plain.
 */

import pc from "picocolors";
import type {
  CheckStatus,
  DoctorReport,
  ResourceCheckResult,
  WiringFinding,
} from "./types";

/** Column at which a row's label starts (`"  ✓  "` → 5), used to align the
 * detail/hint lines beneath it. */
const SUB_INDENT = "     ";

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

/** A status glyph, coloured by severity. */
function glyph(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return pc.green("✓");
    case "warn":
      return pc.yellow("⚠");
    case "error":
      return pc.red("✗");
    default:
      return pc.dim("•");
  }
}

/**
 * Highlights the actionable tokens in a prose detail/hint line. One tight
 * palette: cyan = a literal token you type or reference — a "quoted" id/binding
 * name or a `backticked` code/command span (the delimiters are stripped); bold =
 * a SCREAMING_SNAKE env-var name. Resource *names* aren't highlighted — only the
 * id/code you'd act on is. Nesting is safe: bold's reset (22) doesn't clear the
 * cyan (39), so an env var inside a code span stays bold *and* cyan. Purely
 * cosmetic — a no-op when colour is disabled.
 */
function highlight(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code) => pc.cyan(code))
    .replace(/"([^"]+)"/g, (_, id) => pc.cyan(id))
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (id) => pc.bold(id));
}

/** A sub-line beneath a row (detail or hint), consistently indented. */
function subLine(text: string): void {
  console.log(`${SUB_INDENT}${text}`);
}

/**
 * Prints the expanded body shared by every non-ok row: each indented `detail`
 * line, then (if any) a `Hint:` set off by a blank line above it. Keeps
 * resource, wiring, and auth rows visually identical. Multiple details/hints (a
 * resource can trip more than one layer) are grouped into one block. Callers own
 * the surrounding blank lines (see {@link printReport}), so a body never emits a
 * trailing blank of its own.
 */
function printRowBody(
  details: Array<string | undefined>,
  hints: Array<string | undefined>,
): void {
  for (const d of details) if (d) subLine(highlight(d));
  const realHints = hints.filter((h): h is string => Boolean(h));
  if (realHints.length > 0) {
    console.log("");
    for (const h of realHints) subLine(`${pc.dim("Hint:")} ${highlight(h)}`);
  }
}

/** Row display order: most severe first (stable within a status). */
const DISPLAY_ORDER: Record<CheckStatus, number> = {
  error: 0,
  warn: 1,
  skipped: 2,
  ok: 3,
};

/** Shows only the non-zero categories, coloured by severity. */
function summaryLine(counts: {
  ok: number;
  warn: number;
  error: number;
  skipped: number;
}): string {
  const parts: string[] = [];
  if (counts.error)
    parts.push(pc.red(`${counts.error} error${counts.error > 1 ? "s" : ""}`));
  if (counts.warn)
    parts.push(
      pc.yellow(`${counts.warn} warning${counts.warn > 1 ? "s" : ""}`),
    );
  if (counts.ok) parts.push(pc.green(`${counts.ok} ok`));
  if (counts.skipped) parts.push(pc.dim(`${counts.skipped} skipped`));
  return parts.length > 0 ? parts.join(pc.dim(", ")) : "nothing to check";
}

/** Prints the leading `Auth` check row (always first). On failure, appends the
 * target profile, a hint, and — with `--detail` — the raw SDK error. */
function printAuthRow(report: DoctorReport, detail: boolean): void {
  const { auth } = report;
  console.log(`  ${glyph(auth.status)}  Auth — ${auth.detail ?? auth.status}`);
  // Happy path: just the row. On failure, expand with the target profile, hint,
  // and (with --detail) the raw error — the caller frames it with blank lines.
  if (auth.status !== "error") return;

  // The profile in play is only interesting when auth failed — it's the first
  // thing to sanity-check — so attach it here rather than in a header.
  if (auth.profile) {
    subLine(`${pc.dim("profile:")} ${pc.cyan(auth.profile)}`);
  }
  if (auth.hint) {
    console.log("");
    subLine(`${pc.dim("Hint:")} ${highlight(auth.hint)}`);
  }
  // The full underlying error is hidden by default (the hint explains the fix);
  // `--detail` surfaces it for debugging.
  if (detail && auth.raw) {
    console.log("");
    subLine(pc.dim("Details:"));
    console.log(pc.dim(indent(auth.raw, SUB_INDENT.length + 2)));
  }
}

/**
 * Prints one resource row. On the happy path this is just a tick and the
 * resource name — no plugin/type attribution, no layer noise. Non-ok rows
 * append their actionable layer details (and hints, offset by a blank line)
 * beneath. Bundle-managed resources are noted as deploy-created, not probed.
 */
function printResourceRow(r: ResourceCheckResult): void {
  const { target } = r;
  if (target.origin === "bundle-managed") {
    console.log(
      `  ${pc.dim("⧗")}  ${target.alias}  ${pc.dim("will be created on deploy")}`,
    );
    return;
  }
  console.log(`  ${glyph(r.status)}  ${target.alias}`);
  const problems = r.layers.filter((l) => l.status !== "ok");
  if (problems.length > 0) {
    printRowBody(
      problems.map((l) => l.detail),
      problems.map((l) => l.hint),
    );
  }
}

/** Prints a wiring finding with the same shape as a resource row:
 * `glyph  label` on the first line, then the indented detail and hint. */
function printWiringRow(f: WiringFinding): void {
  console.log(`  ${glyph(f.status)}  ${highlight(f.label)}`);
  printRowBody([f.detail], [f.hint]);
}

/** A unified printable row. `expanded` rows (those with detail/hint beneath the
 * glyph line) get a blank line on either side so they read as their own
 * paragraph; plain `ok` rows pack together. */
interface Row {
  status: CheckStatus;
  expanded: boolean;
  print: () => void;
}

export function printReport(report: DoctorReport, detail = false): void {
  const { resources, wiring, summary, auth } = report;

  // One flat, severity-sorted list — no titled sub-blocks. Auth is always the
  // first row; every resource and wiring finding follows in the same list, so
  // the report reads as a single consistent checklist rather than a mix of
  // headed and headless sections.
  const rows: Row[] = [];

  // Auth leads and never sorts. It expands only on failure.
  rows.push({
    status: auth.status,
    expanded: auth.status === "error",
    print: () => printAuthRow(report, detail),
  });

  // When auth failed, external resources are all auth-skipped; those carry no
  // new information, so collapse the ones whose *only* finding is the auth-skip
  // into a single line (keeping any that also have a real, actionable problem).
  const authSkipped = resources.filter(isOnlyAuthSkipped);
  const checked: Row[] = [];
  for (const r of resources) {
    if (isOnlyAuthSkipped(r)) continue;
    checked.push({
      status: r.status,
      // Bundle-managed rows are a single line ("will be created on deploy");
      // every other non-ok row shows detail beneath, so it's expanded.
      expanded: r.status !== "ok" && r.target.origin !== "bundle-managed",
      print: () => printResourceRow(r),
    });
  }
  if (authSkipped.length > 0) {
    checked.push({
      status: "skipped",
      expanded: false,
      print: () =>
        console.log(
          `  ${pc.dim("•")}  ${pc.dim(
            `${authSkipped.length} resource${authSkipped.length > 1 ? "s" : ""} not checked (auth failed)`,
          )}`,
        ),
    });
  }
  for (const f of wiring) {
    checked.push({
      status: f.status,
      expanded: true,
      print: () => printWiringRow(f),
    });
  }

  // Sort everything after auth by severity; auth stays pinned at the top.
  checked.sort((a, b) => DISPLAY_ORDER[a.status] - DISPLAY_ORDER[b.status]);
  rows.push(...checked);

  // Print with a blank line separating any expanded row from its neighbours, so
  // multi-line findings are set apart while consecutive ok rows stay compact.
  console.log("");
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    if (i > 0 && (row.expanded || prev.expanded)) console.log("");
    row.print();
  });

  // Fold auth failure and wiring findings into the counts so nothing that
  // affects the exit code reads as "0 errors".
  const authError = auth.status === "error" ? 1 : 0;
  const wiringErrors = wiring.filter((w) => w.status === "error").length;
  const wiringWarns = wiring.filter((w) => w.status === "warn").length;
  console.log("");
  console.log(
    summaryLine({
      ...summary,
      error: summary.error + authError + wiringErrors,
      warn: summary.warn + wiringWarns,
    }),
  );
  // Point at --detail when there's more to show and it wasn't requested.
  if (!detail && auth.raw) {
    console.log(pc.dim("\nRun with --detail for full error output."));
  }
  console.log("");
}

export function printReportJson(report: DoctorReport): void {
  console.log(JSON.stringify(report, null, 2));
}

/** Non-zero if auth, any resource, or any wiring finding errored, so
 * `appkit doctor` can gate CI / pre-deploy. */
export function exitCodeFor(report: DoctorReport): number {
  if (report.auth.status === "error") return 1;
  if (report.summary.error > 0) return 1;
  return report.wiring.some((w) => w.status === "error") ? 1 : 0;
}
