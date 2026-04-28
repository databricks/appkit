import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import {
  loadManifestFromFile,
  resolveManifestInDir,
} from "../manifest-resolve";
import { shouldAllowJsManifestForDir } from "../trusted-js-manifest";
import { validateManifest } from "../validate/validate-manifest";

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

const MAX_SCAN_DEPTH = 5;

interface PromoteResult {
  manifestPath: string;
  oldStability: Stability;
  newStability: Stability;
  importRewrites: { file: string; from: string; to: string }[];
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

  const nodeModulesDir = path.join(cwd, "node_modules", "@databricks/appkit");
  if (fs.existsSync(nodeModulesDir)) {
    const pluginsDir = path.join(nodeModulesDir, "dist", "plugins");
    if (fs.existsSync(pluginsDir)) {
      const manifestPath = path.join(pluginsDir, pluginName, "manifest.json");
      if (fs.existsSync(manifestPath)) {
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
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  if (depth >= MAX_SCAN_DEPTH) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = path.join(dir, entry.name);
    const allowJs = shouldAllowJsManifestForDir(childPath);
    const resolved = resolveManifestInDir(childPath, {
      allowJsManifest: allowJs,
    });

    if (resolved) {
      try {
        const obj = loadManifestFromFileSync(resolved.path);
        if (obj && typeof obj === "object" && "name" in obj) {
          if ((obj as { name: string }).name === pluginName) {
            return resolved.path;
          }
        }
      } catch {
        // skip
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

function findTsFiles(dir: string, depth = 0): string[] {
  if (depth >= 10) return [];
  if (!fs.existsSync(dir)) return [];

  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".git"
      )
        continue;
      results.push(...findTsFiles(fullPath, depth + 1));
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
  },
): Promise<void> {
  const cwd = process.cwd();
  const target = options.to as Stability;

  if (!["experimental", "preview", "stable"].includes(target)) {
    console.error(
      `Invalid target tier "${target}". Must be one of: experimental, preview, stable`,
    );
    process.exit(1);
  }

  const found = findPluginManifest(pluginName, cwd);
  if (!found) {
    console.error(
      `Plugin "${pluginName}" not found. Searched local dirs and node_modules.`,
    );
    process.exit(1);
  }

  const { manifestPath } = found;
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const currentStability: Stability = raw.stability ?? "stable";

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

  // Update manifest
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

  // Rewrite imports
  const importRewrites: { file: string; from: string; to: string }[] = [];
  if (!options.skipImports) {
    const oldSuffix = IMPORT_PATH_MAP[currentStability];
    const newSuffix = IMPORT_PATH_MAP[target];

    const tsFiles = findTsFiles(cwd);
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

  // Auto-sync
  if (!options.skipSync && !options.dryRun) {
    console.log(`\n${prefix}Running plugin sync...`);
    const { execSync } = await import("node:child_process");
    try {
      execSync("npx appkit plugin sync --write", {
        cwd,
        stdio: "inherit",
      });
    } catch {
      console.warn("Warning: plugin sync failed. Run manually.");
    }
  }

  console.log(
    `\n${prefix}Promotion complete: ${pluginName} ${currentStability} → ${target}`,
  );
  if (importRewrites.length > 0) {
    console.log(`  ${importRewrites.length} file(s) with import rewrites`);
  }
}

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
  .action((pluginName, opts) =>
    runPromote(pluginName, opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
