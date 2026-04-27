import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { resolveManifestInDir } from "../manifest-resolve";
import { isWithinDirectory } from "../sync/sync";
import { shouldAllowJsManifestForDir } from "../trusted-js-manifest";

type Stability = "experimental" | "preview" | "stable";

const TIER_ORDER: Record<Stability, number> = {
  experimental: 0,
  preview: 1,
  stable: 2,
};

const IMPORT_PATH_MAP: Record<Stability, string> = {
  experimental: "/experimental",
  preview: "/preview",
  stable: "",
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
  return value === "experimental" || value === "preview" || value === "stable";
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

function rewriteImportsInFile(
  filePath: string,
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
    if (updated.includes(oldPath)) {
      updated = updated.split(oldPath).join(newPath);
      changed = true;
    }
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
      `Invalid target tier "${options.to}". Must be one of: experimental, preview, stable.`,
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

  const rawStability = raw.stability ?? "stable";
  if (!isStability(rawStability)) {
    console.error(
      `Manifest at ${path.relative(cwd, manifestPath)} has an invalid stability value "${String(rawStability)}". ` +
        `Must be one of: experimental, preview, stable (or omitted for stable).`,
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

  if (target === "stable") {
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
    console.log(`\n${prefix}Running plugin sync...`);
    const { execSync } = await import("node:child_process");
    try {
      execSync("npx appkit plugin sync --write", {
        cwd,
        stdio: "inherit",
      });
    } catch {
      console.error(
        `Error: post-promote 'plugin sync' failed. Manifest and imports were updated, ` +
          `but appkit.plugins.json may be out of sync. Run 'npx appkit plugin sync --write' manually.`,
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
  .requiredOption(
    "--to <tier>",
    "Target stability tier (experimental, preview, stable)",
  )
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
