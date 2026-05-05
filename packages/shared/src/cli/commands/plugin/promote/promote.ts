import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { resolveManifestInDir } from "../manifest-resolve";
import { isWithinDirectory } from "../sync/sync";
import { shouldAllowJsManifestForDir } from "../trusted-js-manifest";

type Stability = "beta" | "ga";

const TIER_ORDER: Record<Stability, number> = {
  beta: 0,
  ga: 1,
};

const IMPORT_PATH_MAP: Record<Stability, string> = {
  beta: "/beta",
  ga: "",
};

/** Aligned with sync.ts and list.ts; keep all plugin-tree walks at the same cap. */
const MAX_SCAN_DEPTH = 5;

/**
 * Directories that should never be walked when discovering plugin manifests
 * or rewriting imports. Mirrors common build/output trees.
 */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".turbo",
  ".next",
  ".nuxt",
  ".cache",
  ".svelte-kit",
  ".vite",
  ".parcel-cache",
  "coverage",
]);

/**
 * Plugin name charset accepted by the promote command. Mirrors npm package
 * naming (lowercase, dashes, underscores, dots, optional @scope/) and explicitly
 * forbids path separators, traversal, and NUL — so the name cannot escape its
 * intended directory when used in path.join().
 */
const PLUGIN_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function validatePluginName(pluginName: string): void {
  if (!pluginName || pluginName.includes("\0") || pluginName.includes("..")) {
    throw new Error(
      `Invalid plugin name "${pluginName}". Plugin names must not contain "..", or null bytes.`,
    );
  }
  // Backslash is never allowed (treated as a path separator on Windows).
  if (pluginName.includes("\\")) {
    throw new Error(
      `Invalid plugin name "${pluginName}". Plugin names must not contain backslashes.`,
    );
  }
  // Forward slash is only allowed inside the @scope/name form.
  if (pluginName.includes("/") && !pluginName.startsWith("@")) {
    throw new Error(
      `Invalid plugin name "${pluginName}". Plugin names must not contain "/" unless they are a scoped package (e.g. @scope/name).`,
    );
  }
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) {
    throw new Error(
      `Invalid plugin name "${pluginName}". Expected lowercase alphanumeric with optional dashes, underscores, dots, or @scope/ prefix.`,
    );
  }
}

function isStability(value: unknown): value is Stability {
  return value === "beta" || value === "ga";
}

function findPluginManifest(
  pluginName: string,
  cwd: string,
): { manifestPath: string; isLocal: boolean } | null {
  const dirsToScan = ["plugins", "server", "."];

  for (const dir of dirsToScan) {
    const absDir = path.resolve(cwd, dir);
    const result = scanDirForPlugin(absDir, pluginName, cwd, 0);
    if (result) return { manifestPath: result, isLocal: true };
  }

  // node_modules fallback. Validate and bound to the dist/plugins subtree to
  // make sure a malicious or typo'd name cannot escape via path.join.
  const nodeModulesDir = path.join(cwd, "node_modules", "@databricks/appkit");
  if (fs.existsSync(nodeModulesDir)) {
    const pluginsDir = path.join(nodeModulesDir, "dist", "plugins");
    if (fs.existsSync(pluginsDir)) {
      const manifestPath = path.resolve(
        pluginsDir,
        pluginName,
        "manifest.json",
      );
      if (
        isWithinDirectory(manifestPath, pluginsDir) &&
        fs.existsSync(manifestPath)
      ) {
        return { manifestPath, isLocal: false };
      }
    }
  }

  return null;
}

function scanDirForPlugin(
  dir: string,
  pluginName: string,
  cwd: string,
  depth: number,
): string | null {
  if (depth >= MAX_SCAN_DEPTH) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const childPath = path.join(dir, entry.name);
    const allowJs = shouldAllowJsManifestForDir(childPath);
    const resolved = resolveManifestInDir(childPath, {
      allowJsManifest: allowJs,
    });

    if (resolved) {
      try {
        const obj = loadManifestFromFileSync(resolved.path);
        if (
          obj &&
          typeof obj === "object" &&
          "name" in obj &&
          (obj as { name: string }).name === pluginName
        ) {
          return resolved.path;
        }
      } catch {
        // skip unreadable / invalid manifest
      }
      continue;
    }

    const deeper = scanDirForPlugin(childPath, pluginName, cwd, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

function loadManifestFromFileSync(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a kebab-case manifest name to its camelCase JS identifier form
 * (e.g. `vector-search` -> `vectorSearch`). Mirrors the convention used by
 * first-party plugin index files: a manifest's `name` field may be
 * kebab-case (the schema permits `^[a-z][a-z0-9-]*$`), but the actual
 * exported binding is always a JS identifier. We try both forms when
 * matching specifiers in user code.
 */
function manifestNameToBinding(pluginName: string): string {
  return pluginName.replace(/-+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Returns true when the named import specifier `spec` resolves to either
 * `pluginName` itself or its kebab-to-camelCase JS-identifier form.
 * Handles the `name`, `name as alias`, and inline-type (`type name`,
 * `type name as alias`) forms. Matches on the imported binding before any
 * `as` rename so a promotion finds the right specifier regardless of how
 * the user aliased it.
 */
function specifierMatchesPlugin(spec: string, pluginName: string): boolean {
  const stripped = spec.replace(/^type\s+/, "").trim();
  const head = stripped.split(/\s+as\s+/)[0]?.trim();
  if (!head) return false;
  return head === pluginName || head === manifestNameToBinding(pluginName);
}

/**
 * Rewrite imports of `pluginName` from `<pkg><oldSuffix>` to `<pkg><newSuffix>`
 * across one file, leaving every OTHER specifier on the same import line at
 * its original source. The naïve `split/join` approach this replaced was
 * promoting *every* beta specifier in the file along with the targeted
 * plugin — a bug because beta specifiers don't exist at the GA subpath.
 *
 * Behaviour:
 * - If the targeted plugin is the only specifier on an import line, the
 *   line's source is rewritten to the new path.
 * - If the import has multiple specifiers, the targeted one is moved to a
 *   newly-emitted import line at the new source, and the original import
 *   keeps the remaining specifiers at the old source.
 * - Imports that don't reference `pluginName` are left untouched.
 *
 * Multi-line specifier lists, type-only imports (`import type { ... }`),
 * inline-type specifiers (`import { type Foo }`), and `as`-aliased
 * specifiers are all preserved through the rewrite.
 */
function rewriteImportsInFile(
  filePath: string,
  pluginName: string,
  oldSuffix: string,
  newSuffix: string,
  dryRun: boolean,
): { file: string; from: string; to: string } | null {
  const content = fs.readFileSync(filePath, "utf-8");

  const packages = [
    "@databricks/appkit",
    "@databricks/appkit-ui/js",
    "@databricks/appkit-ui/react",
  ];
  let updated = content;
  let changed = false;

  for (const pkg of packages) {
    const oldPath = `${pkg}${oldSuffix}`;
    const newPath = `${pkg}${newSuffix}`;

    // Match: `import [type] { ...specifiers... } from "<oldPath>";`
    // - `[^}]*` lets the specifier list span newlines (safe — TS imports
    //   don't have nested braces inside the specifier list).
    // - Captures the `type ` keyword (if any), the specifier body, and
    //   the surrounding quote style so we can preserve them on output.
    const importRe = new RegExp(
      `import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*(["'])${escapeRegex(oldPath)}\\3\\s*;?`,
      "g",
    );

    updated = updated.replace(
      importRe,
      (full, typeKeyword, specifiers, quote) => {
        const specList: string[] = specifiers
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);

        const promotedSpec = specList.find((s) =>
          specifierMatchesPlugin(s, pluginName),
        );
        if (!promotedSpec) {
          // Plugin not in this import — leave it alone.
          return full;
        }

        const remaining = specList.filter(
          (s) => !specifierMatchesPlugin(s, pluginName),
        );
        changed = true;

        const tk = typeKeyword ?? "";
        const promotedImport = `import ${tk}{ ${promotedSpec} } from ${quote}${newPath}${quote};`;

        if (remaining.length === 0) {
          // Only specifier — just rewrite the source.
          return promotedImport;
        }

        const remainingImport = `import ${tk}{ ${remaining.join(", ")} } from ${quote}${oldPath}${quote};`;
        return `${remainingImport}\n${promotedImport}`;
      },
    );
  }

  if (!changed) return null;

  if (!dryRun) {
    fs.writeFileSync(filePath, updated);
  }

  return {
    file: filePath,
    from: oldSuffix || "(root)",
    to: newSuffix || "(root)",
  };
}

function findTsFiles(dir: string, projectRoot: string, depth = 0): string[] {
  if (depth >= MAX_SCAN_DEPTH) return [];

  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      // Boundary check to ensure recursion stays inside the project root,
      // even if a future change introduces a symlink-following path.
      if (!isWithinDirectory(fullPath, projectRoot)) continue;
      results.push(...findTsFiles(fullPath, projectRoot, depth + 1));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      results.push(fullPath);
    }
  }

  return results;
}

async function runPromote(
  pluginName: string,
  options: {
    to: string;
    dryRun?: boolean;
    skipImports?: boolean;
    skipSync?: boolean;
    allowInstalled?: boolean;
  },
): Promise<void> {
  validatePluginName(pluginName);

  const cwd = process.cwd();

  if (!isStability(options.to)) {
    console.error(
      `Invalid target tier "${options.to}". Must be one of: beta, ga.`,
    );
    process.exit(1);
  }
  const target: Stability = options.to;

  const found = findPluginManifest(pluginName, cwd);
  if (!found) {
    console.error(
      `Plugin "${pluginName}" not found. Searched local dirs (plugins, server, .) and node_modules.`,
    );
    process.exit(1);
  }

  const { manifestPath, isLocal } = found;

  if (!isLocal && !options.allowInstalled) {
    console.error(
      `Plugin "${pluginName}" was only found under node_modules (${path.relative(cwd, manifestPath)}).\n` +
        `Refusing to mutate an installed package — re-install would overwrite the change.\n` +
        `Pass --allow-installed to override (advanced; not recommended).`,
    );
    process.exit(1);
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = loadManifestFromFileSync(manifestPath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(
        `Manifest at ${path.relative(cwd, manifestPath)} is not a JSON object.`,
      );
      process.exit(1);
    }
    raw = parsed as Record<string, unknown>;
  } catch (err) {
    console.error(
      `Failed to read manifest at ${path.relative(cwd, manifestPath)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const rawStability = raw.stability ?? "ga";
  if (!isStability(rawStability)) {
    console.error(
      `Manifest at ${path.relative(cwd, manifestPath)} has an invalid stability value "${String(rawStability)}". ` +
        `Must be one of: beta, ga (or omitted for ga).`,
    );
    process.exit(1);
  }
  const currentStability: Stability = rawStability;

  if (currentStability === target) {
    console.error(
      `Plugin "${pluginName}" is already at "${target}". Nothing to do.`,
    );
    process.exit(1);
  }

  if (TIER_ORDER[target] <= TIER_ORDER[currentStability]) {
    console.error(
      `Cannot demote "${pluginName}" from "${currentStability}" to "${target}". Promotion is one-way only.`,
    );
    process.exit(1);
  }

  const prefix = options.dryRun ? "[dry-run] " : "";

  if (target === "ga") {
    delete raw.stability;
  } else {
    raw.stability = target;
  }

  if (!options.dryRun) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  }
  console.log(
    `${prefix}Updated manifest: ${path.relative(cwd, manifestPath)} (${currentStability} → ${target})`,
  );

  const importRewrites: { file: string; from: string; to: string }[] = [];
  if (!options.skipImports) {
    const oldSuffix = IMPORT_PATH_MAP[currentStability];
    const newSuffix = IMPORT_PATH_MAP[target];

    const tsFiles = findTsFiles(cwd, cwd);
    for (const file of tsFiles) {
      const result = rewriteImportsInFile(
        file,
        pluginName,
        oldSuffix,
        newSuffix,
        Boolean(options.dryRun),
      );
      if (result) {
        importRewrites.push(result);
        console.log(
          `${prefix}Rewritten imports in: ${path.relative(cwd, file)}`,
        );
      }
    }

    if (importRewrites.length === 0) {
      console.log(`${prefix}No import paths to rewrite.`);
    }
  }

  if (!options.skipSync && !options.dryRun) {
    // Monorepo-only: regenerate every artifact derived from plugin
    // manifests (ga/beta export barrels AND the per-plugin docs-page
    // stability banner) so all manifest-derived layers move together.
    // No-op outside the AppKit monorepo (third-party plugin projects don't
    // ship the generators).
    const generatorPath = path.join(cwd, "tools", "generate-plugin-entries.ts");
    if (fs.existsSync(generatorPath)) {
      console.log(`\n${prefix}Regenerating manifest-derived artifacts...`);
      const { execSync } = await import("node:child_process");
      try {
        execSync("pnpm run generate:types", { cwd, stdio: "inherit" });
      } catch {
        console.error(
          `Error: post-promote 'generate:types' failed. ` +
            `Manifest was updated, but generated barrels and docs banners may be stale. ` +
            `Run 'pnpm run generate:types' manually.`,
        );
        process.exit(1);
      }
    }

    console.log(`\n${prefix}Running plugin sync...`);
    const { execSync } = await import("node:child_process");
    // Monorepo flavor: the AppKit monorepo's `pnpm sync:template` script
    // points sync at `template/appkit.plugins.json` (the file shipped to
    // consumers and read by the Go init template), not the project-root
    // default. Detect the monorepo via the same generator-path probe used
    // above and prefer the script when available so the manifest, the
    // synced template, and the runtime barrels stay aligned.
    const syncCommand = fs.existsSync(generatorPath)
      ? "pnpm run sync:template"
      : "npx appkit plugin sync --write";
    try {
      execSync(syncCommand, {
        cwd,
        stdio: "inherit",
      });
    } catch {
      console.error(
        `Error: post-promote sync ('${syncCommand}') failed. ` +
          `Manifest and imports were updated, but the synced plugin manifest ` +
          `may be stale. Run '${syncCommand}' manually.`,
      );
      process.exit(1);
    }
  }

  console.log(
    `\n${prefix}Promotion complete: ${pluginName} ${currentStability} → ${target}`,
  );
  if (importRewrites.length > 0) {
    console.log(`  ${importRewrites.length} file(s) with import rewrites`);
  }
}

/** Exported for testing. */
export {
  PLUGIN_NAME_PATTERN,
  TIER_ORDER,
  IMPORT_PATH_MAP,
  SKIP_DIRECTORIES,
  isStability,
  validatePluginName,
  rewriteImportsInFile,
  runPromote,
};

export const pluginPromoteCommand = new Command("promote")
  .description("Promote a plugin to a higher stability tier")
  .argument("<plugin-name>", "Plugin name to promote")
  .requiredOption("--to <tier>", "Target stability tier (beta, ga)")
  .option("--dry-run", "Show what would change without modifying files")
  .option("--skip-imports", "Only update manifest, skip import path rewriting")
  .option("--skip-sync", "Don't auto-run plugin sync after promotion")
  .option(
    "--allow-installed",
    "Allow promoting a plugin that lives only under node_modules (advanced)",
  )
  .action((pluginName, opts) =>
    runPromote(pluginName, opts).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      if (process.env.DEBUG) console.error(err);
      process.exit(1);
    }),
  );
