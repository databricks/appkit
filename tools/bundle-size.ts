#!/usr/bin/env tsx

/**
 * Measures and tracks the bundle size of the published packages (`appkit`,
 * `appkit-ui`). Three metrics per package:
 *
 *   1. npm tarball (packed) — the gzipped download, via `npm pack --dry-run
 *      --json` on the package dir (dist + bin). Excludes release-only files
 *      (docs/NOTICE/llms/shared CLI) that dist-appkit.ts assembles at publish
 *      time, so it slightly under-reports the true published tarball.
 *   2. `dist/` size split by file type — JS (runtime), type declarations,
 *      source maps, CSS — each raw + gzip. Only `js` is runtime code; maps and
 *      declarations often dominate the raw total.
 *   3. Per-entry import cost — each entry point (`.`, `./react`, ...) bundled
 *      with esbuild, minified and gzipped, with dependencies kept external
 *      (`packages: "external"`). Reflects the reachable own-code cost per
 *      entry, consistent with deps being external/peer at publish time.
 *   4. Per-entry composition (deep modes only, collapsed in the PR comment) —
 *      from esbuild's metafile with code-splitting on: initial (statically
 *      reachable) vs lazy (dynamic-import-only, e.g. apache-arrow) payload,
 *      node_modules weight, own-code size, and a table of every emitted chunk.
 *      Browser packages bundle deps (peerDeps external) so this is the real
 *      consumer bundle; node packages keep deps external (native addons can't
 *      bundle, and a server SDK never ships deps to a browser), so their
 *      node_modules column reads "external".
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
}

// Entry points are derived from each package's publishConfig.exports at measure
// time (see deriveEntries), so new published exports are picked up automatically.
const PACKAGES: PackageConfig[] = [
  {
    name: "@databricks/appkit",
    dir: "packages/appkit",
    platform: "node",
    bundleDeps: false,
  },
  {
    name: "@databricks/appkit-ui",
    dir: "packages/appkit-ui",
    platform: "browser",
    bundleDeps: true,
  },
];

interface PackageJson {
  publishConfig?: { exports?: Record<string, unknown> };
  exports?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
}

/**
 * Derive the JS entry points a consumer can import from the package's
 * publishConfig.exports (the flattened map npm ships). Skips non-JS targets —
 * type-only re-exports (.d.ts), styles (.css), and ./package.json. Sorted by
 * subpath so the set is stable regardless of exports ordering.
 */
function deriveEntries(pkg: PackageJson): { id: string; file: string }[] {
  const exportsMap: Record<string, unknown> =
    pkg.publishConfig?.exports ?? pkg.exports ?? {};
  const entries: { id: string; file: string }[] = [];
  for (const [id, value] of Object.entries(exportsMap)) {
    // publishConfig.exports values are strings here, but resolve a conditions
    // object defensively in case the exports map is used as a fallback.
    const target =
      typeof value === "string"
        ? value
        : ((value as Record<string, string>)?.default ?? null);
    if (typeof target !== "string" || !target.endsWith(".js")) continue;
    entries.push({ id, file: target.replace(/^\.\//, "") });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

// Fail the PR check only when a package's packed tarball grows past BOTH gates,
// so rounding noise never blocks a merge.
const BUDGET = { maxIncreasePct: 5, minIncreaseBytes: 10 * 1024 };

interface ChunkInfo {
  label: string; // the chunk's own entry module, or its largest input
  gzip: number;
  kind: "initial" | "lazy"; // initial = statically reachable from the entry
}

interface Composition {
  // For browser packages this is the consumer bundle (deps bundled, peerDeps
  // external); for node packages it is own code with deps external (as shipped).
  initialGzip: number; // initial (static-import) payload gzip
  lazyGzip: number; // lazy (dynamic-import) payload gzip
  totalGzip: number; // initial + lazy
  own: number; // own-code minified bytes (deps excluded)
  nodeModules: number | null; // deps minified; null when deps external (node pkgs)
  chunks: ChunkInfo[]; // every emitted chunk, initial first then largest-first
}

interface EntryMeasurement {
  id: string;
  gzip: number | null; // total gzip (own code, deps external) — headline import cost
  composition?: Composition;
}

interface SizePair {
  raw: number;
  gzip: number;
}

// dist/ split by file type so sourcemaps and type declarations don't hide
// inside the headline number — only `js` is runtime code.
interface DistBreakdown {
  total: SizePair;
  js: SizePair;
  types: SizePair; // .d.ts / .d.mts / .d.cts
  maps: SizePair; // .js.map, .d.ts.map, ...
  css: SizePair;
  other: SizePair;
  fileCount: number;
}

interface PackageMeasurement {
  name: string;
  tarball: { packed: number; unpacked: number } | null;
  dist: DistBreakdown;
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

function measureDist(dir: string): DistBreakdown {
  const zero = (): SizePair => ({ raw: 0, gzip: 0 });
  const d: DistBreakdown = {
    total: zero(),
    js: zero(),
    types: zero(),
    maps: zero(),
    css: zero(),
    other: zero(),
    fileCount: 0,
  };
  const add = (b: SizePair, raw: number, gzip: number) => {
    b.raw += raw;
    b.gzip += gzip;
  };
  for (const file of walkFiles(dir)) {
    const contents = fs.readFileSync(file);
    const raw = contents.byteLength;
    const gzip = gzipSync(contents).byteLength;
    add(d.total, raw, gzip);
    d.fileCount += 1;
    const bucket = file.endsWith(".map")
      ? d.maps
      : /\.d\.[cm]?ts$/.test(file)
        ? d.types
        : file.endsWith(".css")
          ? d.css
          : /\.[cm]?js$/.test(file)
            ? d.js
            : d.other;
    add(bucket, raw, gzip);
  }
  return d;
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
  totalGzip: number;
  own: number; // minified bytes attributed to non-node_modules inputs
  nodeModules: number; // minified bytes attributed to node_modules inputs
  initialGzip: number; // initial (static-import closure) chunk gzip
  lazyGzip: number; // lazy (dynamic-import-only) chunk gzip
  chunks: ChunkInfo[];
}

type MetaOutput = {
  entryPoint?: string;
  inputs: Record<string, { bytesInOutput: number }>;
};

/** Name a chunk after its own entry module, else its largest input. */
function chunkLabel(out: MetaOutput): string {
  const source =
    out.entryPoint ??
    Object.entries(out.inputs).sort(
      (a, b) => b[1].bytesInOutput - a[1].bytesInOutput,
    )[0]?.[0];
  if (!source) return "chunk";
  const marker = "node_modules/";
  const nm = source.lastIndexOf(marker);
  if (nm !== -1) {
    const parts = source.slice(nm + marker.length).split("/");
    return parts[0].startsWith("@") && parts[1]
      ? `${parts[0]}/${parts[1]}`
      : parts[0];
  }
  return path.basename(source);
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
  const outputs = result.metafile.outputs;
  const jsChunks = Object.keys(outputs).filter((p) => p.endsWith(".js"));

  // Initial payload = the entry chunk plus its static-import closure. esbuild
  // sets `entryPoint` on code-split (dynamic-import) chunks too, so we can't use
  // that flag — walk the static-import graph instead. Anything reachable only
  // via a dynamic import (e.g. apache-arrow) is lazy.
  const entryChunk = jsChunks.find(
    (p) => outputs[p].entryPoint && absFile.endsWith(outputs[p].entryPoint),
  );
  const initial = new Set<string>();
  const stack = entryChunk ? [entryChunk] : [];
  while (stack.length) {
    const p = stack.pop() as string;
    if (initial.has(p)) continue;
    initial.add(p);
    for (const imp of outputs[p].imports) {
      if (imp.kind === "import-statement" && outputs[imp.path]) {
        stack.push(imp.path);
      }
    }
  }

  const a: Analysis = {
    totalGzip: 0,
    own: 0,
    nodeModules: 0,
    initialGzip: 0,
    lazyGzip: 0,
    chunks: [],
  };
  for (const p of jsChunks) {
    const out = outputs[p];
    for (const [input, info] of Object.entries(out.inputs)) {
      if (input.includes("node_modules")) a.nodeModules += info.bytesInOutput;
      else a.own += info.bytesInOutput;
    }
    const file = result.outputFiles.find((f) => f.path.endsWith(p));
    const gzip = file ? gzipSync(file.contents).byteLength : 0;
    a.totalGzip += gzip;
    const kind = initial.has(p) ? "initial" : "lazy";
    if (kind === "initial") a.initialGzip += gzip;
    else a.lazyGzip += gzip;
    a.chunks.push({ label: chunkLabel(out), gzip, kind });
  }
  // Initial chunks first, then lazy; largest first within each group.
  a.chunks.sort(
    (x, y) =>
      (x.kind === y.kind ? 0 : x.kind === "initial" ? -1 : 1) ||
      y.gzip - x.gzip ||
      x.label.localeCompare(y.label),
  );
  return a;
}

async function measureEntry(
  absFile: string,
  platform: Platform,
  deep: boolean,
  bundleExternal: string[] | null,
): Promise<Omit<EntryMeasurement, "id">> {
  if (!fs.existsSync(absFile)) return { gzip: null };
  try {
    // Headline import cost = own code with deps external (what our code weighs,
    // independent of dependency churn). Stable and attributable to our changes.
    const own = await buildAndAnalyze(absFile, platform);

    // Composition view. Browser packages bundle deps (peerDeps external) so it
    // reflects the real consumer bundle — lazy-loaded deps like apache-arrow
    // land in lazy chunks. Node packages keep deps external (as shipped).
    let view = own;
    let nodeModules: number | null = null;
    if (deep && bundleExternal) {
      try {
        view = await buildAndAnalyze(absFile, platform, bundleExternal);
        nodeModules = view.nodeModules;
      } catch {
        view = own; // a dep couldn't be bundled — fall back to the own-code view
      }
    }

    const composition: Composition = {
      initialGzip: view.initialGzip,
      lazyGzip: view.lazyGzip,
      totalGzip: view.totalGzip,
      own: view.own,
      nodeModules,
      chunks: view.chunks,
    };
    return { gzip: own.totalGzip, composition };
  } catch {
    return { gzip: null };
  }
}

/** peerDependencies stay external in the consumer-cost view (consumer provides them). */
function peerExternals(pkg: PackageJson): string[] {
  return Object.keys(pkg.peerDependencies ?? {});
}

async function measurePackage(
  pkg: PackageConfig,
  deep: boolean,
): Promise<PackageMeasurement> {
  const dir = path.join(REPO_ROOT, pkg.dir);
  const manifest = readPackageJson(dir);
  const bundleExternal = pkg.bundleDeps ? peerExternals(manifest) : null;
  const entries = await Promise.all(
    deriveEntries(manifest).map(async (entry) => ({
      id: entry.id,
      ...(await measureEntry(
        path.join(dir, entry.file),
        pkg.platform,
        deep,
        bundleExternal,
      )),
    })),
  );
  return {
    name: pkg.name,
    tarball: measureTarball(dir),
    dist: measureDist(path.join(dir, "dist")),
    entries,
  };
}

async function measureAll(deep: boolean): Promise<PackageMeasurement[]> {
  // Packages (and their entries) are independent esbuild builds — run them
  // concurrently. Promise.all preserves array order, so output stays stable.
  const results = await Promise.all(
    PACKAGES.map((pkg) =>
      measurePackage(pkg, deep).catch((err) => {
        console.error(`bundle-size: failed to measure ${pkg.name}:`, err);
        return null;
      }),
    ),
  );
  return results.filter((r): r is PackageMeasurement => r !== null);
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

/**
 * Neutralize characters in a dynamic label before it goes into a markdown
 * table code-span in the PR comment. Chunk labels and export ids derive from
 * file/dependency names, so strip backticks (break the code span), pipes
 * (break the table) and angle brackets (HTML / `<!-- marker -->` injection).
 */
function mdSafe(s: string): string {
  return s
    .replace(/[`|<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when a size grew past both budget gates (percent AND absolute bytes). */
function exceedsBudget(current: number | null, base: number | null): boolean {
  if (current == null || base == null) return false;
  const delta = current - base;
  if (delta <= 0) return false;
  const pct = base === 0 ? 100 : (delta / base) * 100;
  return pct > BUDGET.maxIncreasePct && delta > BUDGET.minIncreaseBytes;
}

/**
 * Whether a package trips the gate: the packed tarball (own shipped code) for
 * every package, plus — for browser packages — any entry's consumer bundle
 * (deps bundled), so a heavy new/updated dependency also fails the check.
 */
function packageExceedsBudget(
  pkg: PackageMeasurement,
  base: PackageMeasurement | null,
  bundleDeps: boolean | undefined,
): boolean {
  if (
    exceedsBudget(pkg.tarball?.packed ?? null, base?.tarball?.packed ?? null)
  ) {
    return true;
  }
  if (bundleDeps) {
    for (const entry of pkg.entries) {
      const prev = base?.entries.find((e) => e.id === entry.id);
      if (
        exceedsBudget(
          entry.composition?.totalGzip ?? null,
          prev?.composition?.totalGzip ?? null,
        )
      ) {
        return true;
      }
    }
  }
  return false;
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
      ["dist total", pkg.dist.total.raw, base?.dist.total.raw ?? null],
      ["  js", pkg.dist.js.raw, base?.dist.js.raw ?? null],
      ["  type defs", pkg.dist.types.raw, base?.dist.types.raw ?? null],
      ["  sourcemaps", pkg.dist.maps.raw, base?.dist.maps.raw ?? null],
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
    const bundleDeps = PACKAGES.find((p) => p.name === pkg.name)?.bundleDeps;
    const pkgExceeded = packageExceedsBudget(pkg, base, bundleDeps);
    exceeded = exceeded || pkgExceeded;

    lines.push(
      `### \`${pkg.name}\`${pkgExceeded ? " ⚠️ over budget" : ""}`,
      "",
    );
    const hasBaseline = Boolean(baseline);
    lines.push(
      `**npm tarball (packed): ${cell(pkg.tarball?.packed ?? null, base?.tarball?.packed ?? null, hasBaseline)}** — gzipped download (dist + bin; excludes release-only docs/NOTICE).`,
      "",
      "| dist | raw | gzip |",
      "| --- | --- | --- |",
    );
    const bd = base?.dist ?? null;
    const distRows: [string, SizePair, SizePair | null][] = [
      ["JS (runtime)", pkg.dist.js, bd?.js ?? null],
      ["Type declarations", pkg.dist.types, bd?.types ?? null],
      ["Source maps", pkg.dist.maps, bd?.maps ?? null],
      ["CSS", pkg.dist.css, bd?.css ?? null],
      ["Other", pkg.dist.other, bd?.other ?? null],
    ];
    for (const [label, cur, prev] of distRows) {
      if (cur.raw === 0 && (prev?.raw ?? 0) === 0) continue; // skip empty buckets
      lines.push(
        `| ${label} | ${cell(cur.raw, prev?.raw ?? null, hasBaseline)} | ${cell(cur.gzip, prev?.gzip ?? null, hasBaseline)} |`,
      );
    }
    lines.push(
      `| **Total** | ${cell(pkg.dist.total.raw, bd?.total.raw ?? null, hasBaseline)} | ${cell(pkg.dist.total.gzip, bd?.total.gzip ?? null, hasBaseline)} |`,
      "",
    );
    const scope = bundleDeps
      ? "consumer bundle — deps bundled, peerDeps external"
      : "own code — deps external (as shipped)";
    lines.push(
      `<details><summary>Per-entry composition (${scope})</summary>`,
      "",
      "| Entry | Initial (gz) | Lazy (gz) | Total (gz) | node_modules (min) | Own code (min) |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of pkg.entries) {
      const c = entry.composition;
      const pc =
        base?.entries.find((e) => e.id === entry.id)?.composition ?? null;
      const nodeModules =
        c?.nodeModules != null
          ? cell(c.nodeModules, pc?.nodeModules ?? null, hasBaseline)
          : "external";
      // Browser entries are gated on their consumer bundle — flag the offender.
      const entryOverBudget =
        bundleDeps &&
        exceedsBudget(c?.totalGzip ?? null, pc?.totalGzip ?? null);
      const total = `${cell(c?.totalGzip ?? null, pc?.totalGzip ?? null, hasBaseline)}${entryOverBudget ? " ⚠️" : ""}`;
      lines.push(
        `| \`${mdSafe(entry.id)}\` | ${cell(c?.initialGzip ?? null, pc?.initialGzip ?? null, hasBaseline)} | ${cell(c?.lazyGzip ?? null, pc?.lazyGzip ?? null, hasBaseline)} | ${total} | ${nodeModules} | ${cell(c?.own ?? null, pc?.own ?? null, hasBaseline)} |`,
      );
    }
    // Every emitted chunk, per entry.
    const chunkRows = pkg.entries.flatMap((entry) =>
      (entry.composition?.chunks ?? []).map(
        (chunk) =>
          `| \`${mdSafe(entry.id)}\` | \`${mdSafe(chunk.label)}\` | ${chunk.kind} | ${formatBytes(chunk.gzip)} |`,
      ),
    );
    if (chunkRows.length > 0) {
      lines.push(
        "",
        "**Chunks:**",
        "",
        "| Entry | Chunk | Load | Size (gz) |",
        "| --- | --- | --- | --- |",
        ...chunkRows,
      );
    }
    lines.push("", "</details>", "");
  }

  // Deltas render inline in each cell as `value (+/-X)`, only when a value moved.
  // If a baseline exists but nothing moved, say so — otherwise the all-plain
  // tables read as if no comparison happened.
  if (baseline && !exceeded && !/\([+-]/.test(lines.join("\n"))) {
    const introIdx = lines.indexOf(
      "Compared against `bundle-size-baseline.json` (main).",
    );
    if (introIdx !== -1) {
      lines.splice(introIdx + 1, 0, "", "✅ No size changes vs the baseline.");
    }
  }

  if (exceeded) {
    lines.push(
      `> ⚠️ Over budget: a package's shipped tarball, or a browser entry's consumer bundle (deps included), grew by more than **${BUDGET.maxIncreasePct}%** (and >${formatBytes(BUDGET.minIncreaseBytes)}). This check will fail — reduce the size, or acknowledge the increase by updating \`bundle-size-baseline.json\`.`,
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

  // --baseline / --compare do the deep composition pass; the default build
  // report stays fast (own-code only).
  const deep = Boolean(values.baseline || values.compare);

  const run = async () => {
    const results = await measureAll(deep);
    if (values.json) {
      fs.writeFileSync(values.json, JSON.stringify(results, null, 2));
    }

    if (values.baseline) {
      // Never overwrite the baseline with a partial result: a missing package
      // would make its gate fail open (deltas diff against null). Keep the
      // existing baseline instead and signal failure.
      if (results.length !== PACKAGES.length) {
        console.error(
          `bundle-size: measured ${results.length}/${PACKAGES.length} packages — refusing to write a partial baseline.`,
        );
        process.exitCode = 1;
        return;
      }
      const baseline: BaselineFile = { packages: results };
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log(
        `Wrote baseline to ${path.relative(REPO_ROOT, BASELINE_PATH)}`,
      );
      return;
    }

    const baseline = loadBaseline();
    if (values.compare) {
      printTable(results, baseline);
      const { body, exceeded } = renderMarkdown(results, baseline);
      if (values.markdown) fs.writeFileSync(values.markdown, `${body}\n`);
      writeGithubOutput("exceeded", String(exceeded));
      return;
    }

    // Default: local report at the end of a build.
    printTable(results, baseline);
  };

  if (deep) {
    // Explicit CI/dev commands — let failures surface (exit non-zero) so a
    // broken --compare doesn't silently pass the gate with no comment.
    await run();
  } else {
    // Appended to `pnpm build`; a measurement glitch must never break the build.
    await run().catch((err) => console.error("bundle-size:", err));
  }
}

main().catch((err) => {
  // The default build-report path swallows its own errors above, so it never
  // lands here. This catches unexpected --baseline/--compare failures and any
  // argument-parsing error — fail loudly so CI surfaces it. (The no-arg build
  // invocation can't reach here: parseArgs with no args doesn't throw.)
  console.error("bundle-size:", err);
  process.exitCode = 1;
});
