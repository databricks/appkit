/**
 * Injects (or removes) a stability banner at the top of each plugin's docs
 * page based on the plugin's `manifest.json` `stability` field. Closes the
 * docs-side of the "manifest is the single source of truth" promise this
 * PR makes for runtime exports and the synced template manifest.
 *
 * Inputs:  packages/appkit/src/plugins/<name>/manifest.json
 * Outputs: docs/docs/plugins/<doc-file>.md (banner block injected after the H1)
 *
 * Idempotent: each run strips any existing auto-generated banner via the
 * marker comments and re-injects when the manifest's stability is non-stable.
 * Stable / absent stability => banner removed.
 *
 * Run from repo root: pnpm exec tsx tools/generate-plugin-doc-banners.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PLUGINS_DIR = path.join(REPO_ROOT, "packages/appkit/src/plugins");
const DOCS_DIR = path.join(REPO_ROOT, "docs/docs/plugins");

/**
 * Maps a plugin's manifest `name` to the basename of its docs page when
 * the page is named differently from the manifest. Default lookup is
 * `<name>.md`. Add an entry here when you create a doc page that doesn't
 * follow that convention.
 */
const DOC_FILE_OVERRIDES: Record<string, string> = {
  serving: "model-serving.md",
};

const BANNER_START = "<!-- AUTO-GENERATED: stability-banner-start -->";
const BANNER_END = "<!-- AUTO-GENERATED: stability-banner-end -->";

const BANNER_BODY: Record<"beta", string> = {
  beta: `:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from \`@databricks/appkit/beta\`. See [Plugin Stability Tiers](./stability.md).
:::`,
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop any existing auto-generated banner block (and its surrounding blank lines). */
function stripBanner(content: string): string {
  const re = new RegExp(
    `\\n*${escapeRegex(BANNER_START)}[\\s\\S]*?${escapeRegex(BANNER_END)}\\n*`,
    "g",
  );
  return content.replace(re, "\n\n");
}

/** Insert the banner immediately after the first H1 heading. */
function injectBanner(content: string, body: string): string {
  const banner = `${BANNER_START}\n${body}\n${BANNER_END}`;
  const h1 = content.match(/^# .+\n/m);
  if (!h1 || h1.index === undefined) {
    // No H1 found — fall back to prepending after frontmatter (if any) or to the top.
    const fm = content.match(/^---[\s\S]*?\n---\n/);
    const insertAt = fm ? (fm.index ?? 0) + fm[0].length : 0;
    return `${content.slice(0, insertAt)}\n${banner}\n\n${content.slice(insertAt)}`;
  }
  const h1End = h1.index + h1[0].length;
  return `${content.slice(0, h1End)}\n${banner}\n${content.slice(h1End)}`;
}

interface PluginInfo {
  name: string;
  stability: "beta" | "stable";
  docFile: string;
}

function readPluginInfos(): PluginInfo[] {
  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const infos: PluginInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(PLUGINS_DIR, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    const raw = fs.readFileSync(manifestPath, "utf-8");
    let manifest: { name?: string; stability?: string };
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      continue; // not a valid plugin manifest, skip silently
    }

    const tier = manifest.stability ?? "stable";
    if (tier !== "beta" && tier !== "stable") {
      throw new Error(
        `Manifest at ${manifestPath} has invalid stability "${tier}". Must be "beta" or "stable".`,
      );
    }

    const docBasename =
      DOC_FILE_OVERRIDES[manifest.name] ?? `${manifest.name}.md`;
    infos.push({
      name: manifest.name,
      stability: tier,
      docFile: path.join(DOCS_DIR, docBasename),
    });
  }

  return infos.sort((a, b) => a.name.localeCompare(b.name));
}

function main(): void {
  const infos = readPluginInfos();
  const summary: {
    name: string;
    action: "inject" | "strip" | "skip" | "missing";
  }[] = [];

  for (const info of infos) {
    if (!fs.existsSync(info.docFile)) {
      summary.push({ name: info.name, action: "missing" });
      continue;
    }

    const original = fs.readFileSync(info.docFile, "utf-8");
    const stripped = stripBanner(original);
    const next =
      info.stability === "stable"
        ? stripped
        : injectBanner(stripped, BANNER_BODY[info.stability]);

    if (next === original) {
      summary.push({ name: info.name, action: "skip" });
      continue;
    }
    fs.writeFileSync(info.docFile, next, "utf-8");
    summary.push({
      name: info.name,
      action: info.stability === "stable" ? "strip" : "inject",
    });
  }

  for (const s of summary) {
    const rel = path.relative(REPO_ROOT, DOCS_DIR);
    const docName = DOC_FILE_OVERRIDES[s.name] ?? `${s.name}.md`;
    if (s.action === "missing") {
      console.warn(
        `  warn: ${s.name} — no doc page at ${rel}/${docName} (skipping)`,
      );
    } else if (s.action === "skip") {
      // No-op runs are silent to keep the build log clean.
    } else {
      console.log(`  ${s.action}: ${rel}/${docName} (${s.name})`);
    }
  }
}

main();
