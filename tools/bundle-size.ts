#!/usr/bin/env tsx

/**
 * Measures and tracks the bundle size of the published packages (`appkit`,
 * `appkit-ui`). Three metrics per package:
 *
 *   1. Tarball packed / unpacked size — what `npm publish` ships, via
 *      `npm pack --dry-run --json`. Dependencies stay external (matches how
 *      the packages build), so this is the size of our own shipped files.
 *   2. `dist/` raw + gzip total — every built file summed.
 *   3. Per-entry import cost — each entry point (`.`, `./react`, ...) bundled
 *      with esbuild, minified and gzipped, with dependencies kept external
 *      (`packages: "external"`). Reflects the reachable own-code cost per
 *      entry, consistent with deps being external/peer at publish time.
 *
 * Modes:
 *   (default)              Measure both packages and print a console table.
 *                          Appended to `pnpm build` so the report shows at the
 *                          end of a build. Never exits non-zero.
 *   --baseline             Measure and write `bundle-size-baseline.json`.
 *   --compare              Measure, diff against the committed baseline, print
 *                          a table. With --markdown <file> also writes a PR
 *                          comment body; writes `exceeded=<bool>` to
 *                          $GITHUB_OUTPUT when set (gate handled by the caller).
 *   --json <file>          Also write the raw measurements as JSON.
 *
 * Run via `tsx tools/bundle-size.ts` (see the `size*` scripts in package.json).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
// esbuild ships as a transitive of the build toolchain (tsdown/rolldown) and is
// hoisted to the root node_modules (see .npmrc `public-hoist-pattern[]=*`), so
// it resolves here without a root devDependency. Declaring it directly would
// satisfy webpack's optional `esbuild` peer in the docs workspace and re-key the
// entire docusaurus lockfile graph — hence the intentional undeclared import.
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(REPO_ROOT, "bundle-size-baseline.json");

type Platform = "node" | "browser";

interface PackageConfig {
  name: string;
  dir: string;
  platform: Platform;
  entries: { id: string; file: string }[];
}

const PACKAGES: PackageConfig[] = [
  {
    name: "@databricks/appkit",
    dir: "packages/appkit",
    platform: "node",
    entries: [
      { id: ".", file: "dist/index.js" },
      { id: "./beta", file: "dist/beta.js" },
    ],
  },
  {
    name: "@databricks/appkit-ui",
    dir: "packages/appkit-ui",
    platform: "browser",
    entries: [
      { id: "./js", file: "dist/js/index.js" },
      { id: "./js/beta", file: "dist/js/beta.js" },
      { id: "./react", file: "dist/react/index.js" },
      { id: "./react/beta", file: "dist/react/beta.js" },
    ],
  },
];

// Fail the PR check only when a package's packed tarball grows past BOTH gates,
// so rounding noise never blocks a merge.
const BUDGET = { maxIncreasePct: 5, minIncreaseBytes: 10 * 1024 };

interface EntryMeasurement {
  id: string;
  minified: number | null;
  gzip: number | null;
}

interface PackageMeasurement {
  name: string;
  tarball: { packed: number; unpacked: number } | null;
  dist: { raw: number; gzip: number; fileCount: number };
  entries: EntryMeasurement[];
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function measureDist(dir: string): PackageMeasurement["dist"] {
  let raw = 0;
  let gzip = 0;
  let fileCount = 0;
  for (const file of walkFiles(dir)) {
    const contents = fs.readFileSync(file);
    raw += contents.byteLength;
    gzip += gzipSync(contents).byteLength;
    fileCount += 1;
  }
  return { raw, gzip, fileCount };
}

function measureTarball(dir: string): PackageMeasurement["tarball"] {
  try {
    const stdout = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(stdout)[0];
    return { packed: parsed.size, unpacked: parsed.unpackedSize };
  } catch {
    return null;
  }
}

async function measureEntry(
  absFile: string,
  platform: Platform,
): Promise<Omit<EntryMeasurement, "id">> {
  if (!fs.existsSync(absFile)) return { minified: null, gzip: null };
  try {
    const result = await build({
      entryPoints: [absFile],
      bundle: true,
      write: false,
      minify: true,
      format: "esm",
      platform,
      packages: "external",
      legalComments: "none",
      logLevel: "silent",
      loader: { ".css": "empty" },
    });
    const js =
      result.outputFiles.find((f) => f.path.endsWith(".js")) ??
      result.outputFiles[0];
    return {
      minified: js.contents.byteLength,
      gzip: gzipSync(js.contents).byteLength,
    };
  } catch {
    return { minified: null, gzip: null };
  }
}

async function measurePackage(pkg: PackageConfig): Promise<PackageMeasurement> {
  const dir = path.join(REPO_ROOT, pkg.dir);
  const entries: EntryMeasurement[] = [];
  for (const entry of pkg.entries) {
    const cost = await measureEntry(path.join(dir, entry.file), pkg.platform);
    entries.push({ id: entry.id, ...cost });
  }
  return {
    name: pkg.name,
    tarball: measureTarball(dir),
    dist: measureDist(path.join(dir, "dist")),
    entries,
  };
}

async function measureAll(): Promise<PackageMeasurement[]> {
  const results: PackageMeasurement[] = [];
  for (const pkg of PACKAGES) {
    try {
      results.push(await measurePackage(pkg));
    } catch (err) {
      console.error(`bundle-size: failed to measure ${pkg.name}:`, err);
    }
  }
  return results;
}

function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : value < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDelta(current: number | null, base: number | null): string {
  if (current == null || base == null) return "—";
  const delta = current - base;
  if (delta === 0) return "no change";
  const pct = base === 0 ? 0 : (delta / base) * 100;
  const sign = delta > 0 ? "+" : "-";
  return `${sign}${formatBytes(Math.abs(delta))} (${sign}${Math.abs(pct).toFixed(1)}%)`;
}

/** True when the packed tarball grew past both budget gates. */
function exceedsBudget(current: number | null, base: number | null): boolean {
  if (current == null || base == null) return false;
  const delta = current - base;
  if (delta <= 0) return false;
  const pct = base === 0 ? 100 : (delta / base) * 100;
  return pct > BUDGET.maxIncreasePct && delta > BUDGET.minIncreaseBytes;
}

function printTable(
  results: PackageMeasurement[],
  baseline: BaselineFile | null,
) {
  console.log("\n📦 Bundle size\n");
  for (const pkg of results) {
    const base = baseline?.packages.find((p) => p.name === pkg.name) ?? null;
    console.log(`  ${pkg.name}`);
    const rows: [string, number | null, number | null][] = [
      [
        "tarball packed",
        pkg.tarball?.packed ?? null,
        base?.tarball?.packed ?? null,
      ],
      [
        "tarball unpacked",
        pkg.tarball?.unpacked ?? null,
        base?.tarball?.unpacked ?? null,
      ],
      ["dist raw", pkg.dist.raw, base?.dist.raw ?? null],
      ["dist gzip", pkg.dist.gzip, base?.dist.gzip ?? null],
    ];
    for (const [label, cur, prev] of rows) {
      const delta = baseline ? `  ${formatDelta(cur, prev)}` : "";
      console.log(
        `    ${label.padEnd(18)} ${formatBytes(cur).padStart(9)}${delta}`,
      );
    }
    for (const entry of pkg.entries) {
      const prev = base?.entries.find((e) => e.id === entry.id);
      const delta = baseline
        ? `  ${formatDelta(entry.gzip, prev?.gzip ?? null)}`
        : "";
      console.log(
        `    entry ${entry.id.padEnd(12)} ${formatBytes(entry.gzip).padStart(9)} gz${delta}`,
      );
    }
    console.log("");
  }
}

interface BaselineFile {
  packages: PackageMeasurement[];
}

function loadBaseline(): BaselineFile | null {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function renderMarkdown(
  results: PackageMeasurement[],
  baseline: BaselineFile | null,
): { body: string; exceeded: boolean } {
  const MARKER = "<!-- bundle-size-report -->";
  const lines: string[] = [MARKER, "## 📦 Bundle size report", ""];
  let exceeded = false;

  if (baseline) {
    lines.push("Compared against `bundle-size-baseline.json` (main).", "");
  } else {
    lines.push(
      "> No committed baseline found — showing current sizes only. Deltas appear once `bundle-size-baseline.json` lands on `main`.",
      "",
    );
  }

  for (const pkg of results) {
    const base = baseline?.packages.find((p) => p.name === pkg.name) ?? null;
    const pkgExceeded = exceedsBudget(
      pkg.tarball?.packed ?? null,
      base?.tarball?.packed ?? null,
    );
    exceeded = exceeded || pkgExceeded;

    lines.push(`### \`${pkg.name}\`${pkgExceeded ? " ⚠️ over budget" : ""}`, "");
    lines.push("| Metric | main | this PR | Δ |", "| --- | --- | --- | --- |");
    const rows: [string, number | null, number | null][] = [
      [
        "Tarball (packed)",
        pkg.tarball?.packed ?? null,
        base?.tarball?.packed ?? null,
      ],
      [
        "Tarball (unpacked)",
        pkg.tarball?.unpacked ?? null,
        base?.tarball?.unpacked ?? null,
      ],
      ["dist (raw)", pkg.dist.raw, base?.dist.raw ?? null],
      ["dist (gzip)", pkg.dist.gzip, base?.dist.gzip ?? null],
    ];
    for (const [label, cur, prev] of rows) {
      lines.push(
        `| ${label} | ${formatBytes(prev)} | ${formatBytes(cur)} | ${baseline ? formatDelta(cur, prev) : "—"} |`,
      );
    }
    lines.push("");
    lines.push(
      "<details><summary>Per-entry import cost (minified + gzip, deps external)</summary>",
      "",
      "| Entry | main (gz) | this PR (gz) | Δ gz |",
      "| --- | --- | --- | --- |",
    );
    for (const entry of pkg.entries) {
      const prev = base?.entries.find((e) => e.id === entry.id) ?? null;
      lines.push(
        `| \`${entry.id}\` | ${formatBytes(prev?.gzip ?? null)} | ${formatBytes(entry.gzip)} | ${baseline ? formatDelta(entry.gzip, prev?.gzip ?? null) : "—"} |`,
      );
    }
    lines.push("", "</details>", "");
  }

  if (exceeded) {
    lines.push(
      `> ⚠️ A package's packed tarball grew by more than **${BUDGET.maxIncreasePct}%** (and >${formatBytes(BUDGET.minIncreaseBytes)}). This check will fail — reduce the size or acknowledge the increase by updating \`bundle-size-baseline.json\`.`,
    );
  }

  return { body: lines.join("\n"), exceeded };
}

function writeGithubOutput(key: string, value: string) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile) return;
  fs.appendFileSync(outFile, `${key}=${value}\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      baseline: { type: "boolean", default: false },
      compare: { type: "boolean", default: false },
      markdown: { type: "string" },
      json: { type: "string" },
    },
  });

  const results = await measureAll();

  if (values.json) {
    fs.writeFileSync(values.json, JSON.stringify(results, null, 2));
  }

  if (values.baseline) {
    const baseline: BaselineFile = { packages: results };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Wrote baseline to ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  if (values.compare) {
    const baseline = loadBaseline();
    printTable(results, baseline);
    const { body, exceeded } = renderMarkdown(results, baseline);
    if (values.markdown) fs.writeFileSync(values.markdown, `${body}\n`);
    writeGithubOutput("exceeded", String(exceeded));
    return;
  }

  // Default: local report at the end of a build. Show deltas if a baseline
  // exists, but never fail the build.
  printTable(results, loadBaseline());
}

main().catch((err) => {
  // Default/measure path must not break `pnpm build`.
  console.error("bundle-size:", err);
});
