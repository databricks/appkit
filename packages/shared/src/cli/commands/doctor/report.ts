/**
 * Rendering for `appkit doctor` — turns a {@link DoctorReport} into a
 * human-readable console report or JSON.
 */

import pc from "picocolors";
import {
  AUTH_UNAVAILABLE_CODE,
  BUNDLE_MANAGED_CODE,
  type CheckStatus,
  type DoctorReport,
  type ResourceCheckResult,
  STATUS_SEVERITY,
  type WiringFinding,
} from "./types";

/** Column at which a row's label starts, to align detail/hint lines beneath. */
const SUB_INDENT = "     ";

/**
 * True when a resource's only finding is an auth-skipped existence probe, so it
 * can be collapsed into one summary line.
 */
function isOnlyAuthSkipped(r: ResourceCheckResult): boolean {
  if (r.status !== "skipped") return false;
  const hasAuthSkip = r.layers.some(
    (l) => l.layer === "existence" && l.code === AUTH_UNAVAILABLE_CODE,
  );
  if (!hasAuthSkip) return false;
  return r.layers.every(
    (l) =>
      l.status === "ok" ||
      (l.layer === "existence" && l.code === AUTH_UNAVAILABLE_CODE),
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
 * Highlights actionable tokens in a detail/hint line: cyan for a "quoted" id or
 * `backticked` code span (delimiters stripped), bold for a SCREAMING_SNAKE env
 * var. Nesting is safe — bold's reset (22) doesn't clear the cyan (39).
 *
 * Bold runs *first*: the cyan passes wrap their match in ANSI escapes, which
 * would put a `\x1b[36m` between the word boundary and the env-var name and stop
 * the `\b` anchor matching — so an env var inside a code span or quotes would
 * never get bold.
 */
function highlight(text: string): string {
  return text
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (id) => pc.bold(id))
    .replace(/`([^`]+)`/g, (_, code) => pc.cyan(code))
    .replace(/"([^"]+)"/g, (_, id) => pc.cyan(id));
}

/** A sub-line beneath a row (detail or hint), consistently indented. */
function subLine(text: string): void {
  console.log(`${SUB_INDENT}${text}`);
}

/**
 * Prints the expanded body of a non-ok row: each indented `detail` line, then
 * any `Hint:` set off by a blank line. Callers own the surrounding blank lines.
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
 * workspace and profile in play, a hint, and — with `--detail` — the raw SDK
 * error. The host matters as much as the profile: `DATABRICKS_HOST` overrides a
 * profile's host, so the two can come from different places. */
function printAuthRow(report: DoctorReport, detail: boolean): void {
  const { auth } = report;
  console.log(`  ${glyph(auth.status)}  Auth — ${auth.detail ?? auth.status}`);
  // A warn carries a config problem (e.g. a host/profile split) whose hint needs
  // the same host/profile context as an outright failure.
  if (auth.status !== "error" && auth.status !== "warn") return;

  if (auth.host) {
    subLine(`${pc.dim("host:")}    ${pc.cyan(auth.host)}`);
  }
  if (auth.profile) {
    subLine(`${pc.dim("profile:")} ${pc.cyan(auth.profile)}`);
  }
  if (auth.hint) {
    console.log("");
    subLine(`${pc.dim("Hint:")} ${highlight(auth.hint)}`);
  }
  if (detail && auth.raw) {
    console.log("");
    subLine(pc.dim("Details:"));
    console.log(pc.dim(indent(auth.raw, SUB_INDENT.length + 2)));
  }
}

/**
 * Prints one resource row: a tick and the name on the happy path, actionable
 * layer details beneath otherwise. Bundle-managed resources are noted as
 * deploy-created, not probed.
 */
function printResourceRow(r: ResourceCheckResult): void {
  const { target } = r;
  const bundleManaged = target.origin === "bundle-managed";
  console.log(
    bundleManaged
      ? `  ${pc.dim("⧗")}  ${target.alias}  ${pc.dim("will be created on deploy")}`
      : `  ${glyph(r.status)}  ${target.alias}`,
  );
  // Never swallow a finding: a bundle-managed row used to drop its layers, so an
  // error counted in the summary had no visible cause. `BUNDLE_MANAGED` is the
  // expected skip and would just restate the row, so it alone stays quiet.
  const problems = r.layers.filter(
    (l) => l.status !== "ok" && l.code !== BUNDLE_MANAGED_CODE,
  );
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

/** A unified printable row. `expanded` rows get a blank line on either side;
 * plain `ok` rows pack together. */
interface Row {
  status: CheckStatus;
  expanded: boolean;
  print: () => void;
}

export function printReport(report: DoctorReport, detail = false): void {
  const { resources, wiring, setup, summary, auth } = report;

  // One flat, severity-sorted list. Auth leads and never sorts.
  const rows: Row[] = [];
  rows.push({
    status: auth.status,
    expanded: auth.status === "error" || auth.status === "warn",
    print: () => printAuthRow(report, detail),
  });

  // When auth failed, resources whose only finding is the auth-skip carry no
  // new information, so collapse them into a single line.
  const authSkipped: ResourceCheckResult[] = [];
  const checked: Row[] = [];
  for (const r of resources) {
    if (isOnlyAuthSkipped(r)) {
      authSkipped.push(r);
      continue;
    }
    checked.push({
      status: r.status,
      // A bundle-managed row is a one-liner unless it carries a real finding, in
      // which case it needs the spacing every expanded row gets.
      expanded:
        r.status !== "ok" &&
        r.layers.some(
          (l) => l.status !== "ok" && l.code !== BUNDLE_MANAGED_CODE,
        ),
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
  // Setup notices share the wiring row shape (same `label`/`detail`/`hint`).
  for (const f of setup) {
    checked.push({
      status: f.status,
      expanded: true,
      print: () => printWiringRow(f),
    });
  }

  // Most severe first (descending severity); stable within a status.
  checked.sort((a, b) => STATUS_SEVERITY[b.status] - STATUS_SEVERITY[a.status]);
  rows.push(...checked);

  // A blank line sets any expanded row apart from its neighbours.
  console.log("");
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    if (i > 0 && (row.expanded || prev.expanded)) console.log("");
    row.print();
  });

  // `summary` already counts auth + wiring (built authoritatively in run.ts),
  // so render it directly — no re-folding, and it matches what --json emits.
  console.log("");
  console.log(summaryLine(summary));
  // Point at --detail when there's more to show and it wasn't requested.
  if (!detail && auth.raw) {
    console.log(pc.dim("\nRun with --detail for full error output."));
  }
  console.log("");
}

/**
 * Emits the report as JSON. The raw SDK error (`auth.raw`) can carry sensitive
 * detail, so — matching the human report's `--detail` gate — it's stripped
 * unless `detail` is set. `--json --detail` opts back into the full error.
 */
export function printReportJson(report: DoctorReport, detail = false): void {
  const emitted =
    detail || report.auth.raw === undefined
      ? report
      : { ...report, auth: { ...report.auth, raw: undefined } };
  console.log(JSON.stringify(emitted, null, 2));
}
