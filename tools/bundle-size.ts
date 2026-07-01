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
 *   4. Per-entry composition (deep modes only, collapsed in the PR comment) —
 *      from esbuild's metafile with code-splitting on: own-code size, initial
 *      vs lazy-loaded chunks, and — for browser packages whose deps can be
 *      bundled — the node_modules weight a consumer would pay (peerDeps stay
 *      external). Node packages keep deps external (native addons can't bundle
 *      and a server SDK never ships deps to a browser), so their node_modules
 *      column reads "external".
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
  // When true, the composition pass bundles dependencies (except peerDeps) to
  // reveal node_modules weight. Only sound for browser packages: node packages
  // have native deps that can't bundle and never ship deps to a browser.
  bundleDeps: boolean;
  entries: { id: string; file: string }[];
}

const PACKAGES: PackageConfig[] = [
  {
    name: "@databricks/appkit",
    dir: "packages/appkit",
    platform: "node",
    bundleDeps: false,
    entries: [
      { id: ".", file: "dist/index.js" },
      { id: "./beta", file: "dist/beta.js" },
    ],
  },
  {
    name: "@databricks/appkit-ui",
    dir: "packages/appkit-ui",
    platform: "browser",
    bundleDeps: true,
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

interface ChunkInfo {
  label: string; // derived from the chunk's largest input (module or dep name)
  gzip: number;
}

interface Composition {
  own: number; // own-code minified bytes (source-attributed, deps excluded)
  initialGzip: number; // entry chunk gzip
  lazyGzip: number; // sum of dynamically-imported (lazy) chunk gzip
  lazyChunks: number; // number of lazy chunks
  lazyChunkList: ChunkInfo[]; // each lazy chunk, largest first
  // Deps-bundled view: what a consumer pays with node_modules bundled in
  // (peerDeps still external). Null when deps stay external (node packages).
  nodeModules: number | null; // node_modules minified bytes
  bundledGzip: number | null; // total gzip with deps bundled
}

interface EntryMeasurement {
  id: string;
  minified: number | null; // total minified (own code, deps external)
  gzip: number | null; // total gzip (own code, deps external) — headline import cost
  composition?: Composition;
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

interface Analysis {
  totalMinified: number;
  totalGzip: number;
  own: number; // minified bytes attributed to non-node_modules inputs
  nodeModules: number; // minified bytes attributed to node_modules inputs
  initialGzip: number; // entry chunk gzip
  lazyGzip: number; // sum of non-entry (lazy) chunk gzip
  lazyChunks: number;
  lazyChunkList: ChunkInfo[];
}

/** Name a chunk after its largest input module (or dependency package). */
function chunkLabel(inputs: Record<string, { bytesInOutput: number }>): string {
  let best = "";
  let max = -1;
  for (const [input, info] of Object.entries(inputs)) {
    if (info.bytesInOutput > max) {
      max = info.bytesInOutput;
      best = input;
    }
  }
  if (!best) return "chunk";
  const marker = "node_modules/";
  const nm = best.lastIndexOf(marker);
  if (nm !== -1) {
    const parts = best.slice(nm + marker.length).split("/");
    return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return path.basename(best);
}

/**
 * Bundle a single entry with code-splitting and read esbuild's metafile to
 * attribute output bytes to own-code vs node_modules and to initial vs lazy
 * chunks. When `external` is given, only those specifiers stay external (deps
 * are bundled); otherwise all bare imports are external (`packages: "external"`).
 */
async function buildAndAnalyze(
  absFile: string,
  platform: Platform,
  external?: string[],
): Promise<Analysis> {
  const result = await build({
    entryPoints: [absFile],
    bundle: true,
    write: false,
    minify: true,
    splitting: true,
    format: "esm",
    platform,
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
    outdir: "__bundle_size__", // naming only; write:false emits nothing to disk
    loader: { ".css": "empty" },
    ...(external ? { external } : { packages: "external" }),
  });
  const meta = result.metafile;
  const a: Analysis = {
    totalMinified: 0,
    totalGzip: 0,
    own: 0,
    nodeModules: 0,
    initialGzip: 0,
    lazyGzip: 0,
    lazyChunks: 0,
    lazyChunkList: [],
  };
  for (const [outPath, out] of Object.entries(meta.outputs)) {
    if (!outPath.endsWith(".js")) continue;
    a.totalMinified += out.bytes;
    for (const [input, info] of Object.entries(out.inputs)) {
      if (input.includes("node_modules")) a.nodeModules += info.bytesInOutput;
      else a.own += info.bytesInOutput;
    }
    const file = result.outputFiles.find((f) => f.path.endsWith(outPath));
    const gzip = file ? gzipSync(file.contents).byteLength : 0;
    a.totalGzip += gzip;
    if (out.entryPoint) a.initialGzip += gzip;
    else {
      a.lazyGzip += gzip;
      a.lazyChunks += 1;
      a.lazyChunkList.push({ label: chunkLabel(out.inputs), gzip });
    }
  }
  a.lazyChunkList.sort(
    (x, y) => y.gzip - x.gzip || x.label.localeCompare(y.label),
  );
  return a;
}

async function measureEntry(
  absFile: string,
  platform: Platform,
  deep: boolean,
  bundleExternal: string[] | null,
): Promise<Omit<EntryMeasurement, "id">> {
  if (!fs.existsSync(absFile)) return { minified: null, gzip: null };
  try {
    // Own-code cost (deps external) — the headline, stable import cost.
    const own = await buildAndAnalyze(absFile, platform);
    const composition: Composition = {
      own: own.own,
      initialGzip: own.initialGzip,
      lazyGzip: own.lazyGzip,
      lazyChunks: own.lazyChunks,
      lazyChunkList: own.lazyChunkList,
      nodeModules: null,
      bundledGzip: null,
    };
    // Deps-bundled view (browser packages, deep modes only). Best-effort: if a
    // dep can't be bundled, leave the node_modules columns empty. Browser
    // packages lazy-load dependencies (e.g. apache-arrow), not their own
    // modules, so the meaningful lazy chunks only appear once deps are bundled —
    // take the lazy split and chunk list from this build too.
    if (deep && bundleExternal) {
      try {
        const bundled = await buildAndAnalyze(
          absFile,
          platform,
          bundleExternal,
        );
        composition.nodeModules = bundled.nodeModules;
        composition.bundledGzip = bundled.totalGzip;
        composition.lazyGzip = bundled.lazyGzip;
        composition.lazyChunks = bundled.lazyChunks;
        composition.lazyChunkList = bundled.lazyChunkList;
      } catch {
        // leave deps-bundled fields at their own-code defaults
      }
    }
    return { minified: own.totalMinified, gzip: own.totalGzip, composition };
  } catch {
    return { minified: null, gzip: null };
  }
}

/** peerDependencies stay external in the consumer-cost view (consumer provides them). */
function peerExternals(dir: string): string[] {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
  );
  return Object.keys(pkg.peerDependencies ?? {});
}

async function measurePackage(
  pkg: PackageConfig,
  deep: boolean,
): Promise<PackageMeasurement> {
  const dir = path.join(REPO_ROOT, pkg.dir);
  const bundleExternal = pkg.bundleDeps ? peerExternals(dir) : null;
  const entries: EntryMeasurement[] = [];
  for (const entry of pkg.entries) {
    const cost = await measureEntry(
      path.join(dir, entry.file),
      pkg.platform,
      deep,
      bundleExternal,
    );
    entries.push({ id: entry.id, ...cost });
  }
  return {
    name: pkg.name,
    tarball: measureTarball(dir),
    dist: measureDist(path.join(dir, "dist")),
    entries,
  };
}

async function measureAll(deep: boolean): Promise<PackageMeasurement[]> {
  const results: PackageMeasurement[] = [];
  for (const pkg of PACKAGES) {
    try {
      results.push(await measurePackage(pkg, deep));
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

/** A value cell with an optional compact signed delta, e.g. "166 KB (+2 KB)". */
function cell(
  current: number | null,
  base: number | null,
  hasBaseline: boolean,
): string {
  const value = formatBytes(current);
  if (!hasBaseline || current == null || base == null) return value;
  const delta = current - base;
  if (delta === 0) return value;
  return `${value} (${delta > 0 ? "+" : "-"}${formatBytes(Math.abs(delta))})`;
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
    const bundleDeps = PACKAGES.find((p) => p.name === pkg.name)?.bundleDeps;
    lines.push(
      "<details><summary>Per-entry composition — own code (deps external) + lazy chunks; node_modules = weight if bundled</summary>",
      "",
      "| Entry | Import cost (gz) | Own code (min) | Lazy (gz) | node_modules (min) | + deps total (gz) |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of pkg.entries) {
      const prev = base?.entries.find((e) => e.id === entry.id) ?? null;
      const c = entry.composition;
      const pc = prev?.composition ?? null;
      const lazy =
        c && c.lazyChunks > 0
          ? `${formatBytes(c.lazyGzip)} · ${c.lazyChunks} chunk${c.lazyChunks > 1 ? "s" : ""}`
          : "none";
      const nodeModules =
        c?.nodeModules != null
          ? cell(c.nodeModules, pc?.nodeModules ?? null, Boolean(baseline))
          : bundleDeps
            ? "n/a"
            : "external";
      const bundled =
        c?.bundledGzip != null
          ? formatBytes(c.bundledGzip)
          : bundleDeps
            ? "n/a"
            : "—";
      lines.push(
        `| \`${entry.id}\` | ${cell(entry.gzip, prev?.gzip ?? null, Boolean(baseline))} | ${cell(c?.own ?? null, pc?.own ?? null, Boolean(baseline))} | ${lazy} | ${nodeModules} | ${bundled} |`,
      );
    }
    // List the individual lazy chunks (gzip) under the table.
    const withChunks = pkg.entries.filter(
      (e) => (e.composition?.lazyChunkList?.length ?? 0) > 0,
    );
    if (withChunks.length > 0) {
      lines.push("", "**Lazy chunks (gzip):**");
      for (const entry of withChunks) {
        for (const chunk of entry.composition?.lazyChunkList ?? []) {
          lines.push(
            `- \`${entry.id}\` → \`${chunk.label}\` ${formatBytes(chunk.gzip)}`,
          );
        }
      }
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

  // The composition pass (bundling deps for browser packages) is only needed
  // for the baseline and the PR comparison, not the fast local build report.
  const deep = Boolean(values.baseline || values.compare);
  const results = await measureAll(deep);

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
