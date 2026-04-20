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

/** Safety limit for recursive directory scanning to prevent runaway traversal. */
const MAX_SCAN_DEPTH = 5;

export interface PluginRow {
  name: string;
  displayName: string;
  package: string;
  required: number;
  optional: number;
}

export function listFromManifestFile(manifestPath: string): PluginRow[] {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read manifest file ${manifestPath}: ${msg}`);
  }

  let data: {
    plugins?: Record<
      string,
      {
        name: string;
        displayName: string;
        package: string;
        resources: { required: unknown[]; optional: unknown[] };
      }
    >;
  };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse manifest file ${manifestPath}: ${msg}`);
  }

  const plugins = data.plugins ?? {};
  return Object.values(plugins).map((p) => ({
    name: p.name,
    displayName: p.displayName ?? p.name,
    package: p.package ?? "",
    required: Array.isArray(p.resources?.required)
      ? p.resources.required.length
      : 0,
    optional: Array.isArray(p.resources?.optional)
      ? p.resources.optional.length
      : 0,
  }));
}

async function collectPluginsRecursive(
  dir: string,
  cwd: string,
  rows: PluginRow[],
  allowJsManifest: boolean,
  depth = 0,
): Promise<void> {
  if (
    !fs.existsSync(dir) ||
    !fs.statSync(dir).isDirectory() ||
    depth >= MAX_SCAN_DEPTH
  )
    return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const childPath = path.join(dir, entry.name);
    const allowJsForChild =
      allowJsManifest || shouldAllowJsManifestForDir(childPath);
    const resolvedManifest = resolveManifestInDir(childPath, {
      allowJsManifest: allowJsForChild,
    });

    if (resolvedManifest) {
      try {
        const obj = await loadManifestFromFile(
          resolvedManifest.path,
          resolvedManifest.type,
          { allowJsManifest: allowJsForChild },
        );
        const result = validateManifest(obj);
        const manifest = result.valid ? result.manifest : null;
        if (manifest) {
          const relPath = path.relative(
            cwd,
            path.dirname(resolvedManifest.path),
          );
          const packagePath = relPath.startsWith(".")
            ? relPath
            : `./${relPath}`;
          rows.push({
            name: manifest.name,
            displayName: manifest.displayName ?? manifest.name,
            package: packagePath,
            required: Array.isArray(manifest.resources?.required)
              ? manifest.resources.required.length
              : 0,
            optional: Array.isArray(manifest.resources?.optional)
              ? manifest.resources.optional.length
              : 0,
          });
        }
      } catch {
        // skip invalid manifests
      }
      continue;
    }

    await collectPluginsRecursive(
      childPath,
      cwd,
      rows,
      allowJsManifest,
      depth + 1,
    );
  }
}

export async function listFromDirectory(
  dirPath: string,
  cwd: string,
  allowJsManifest = false,
): Promise<PluginRow[]> {
  const resolved = path.resolve(cwd, dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return [];
  }
  const rows: PluginRow[] = [];
  await collectPluginsRecursive(resolved, cwd, rows, allowJsManifest);
  return rows;
}

function printTable(rows: PluginRow[]): void {
  if (rows.length === 0) {
    console.log("No plugins found.");
    return;
  }
  const maxName = Math.max(4, ...rows.map((r) => r.name.length));
  const maxDisplay = Math.max(10, ...rows.map((r) => r.displayName.length));
  const maxPkg = Math.max(7, ...rows.map((r) => r.package.length));
  const header = [
    "NAME".padEnd(maxName),
    "DISPLAY NAME".padEnd(maxDisplay),
    "PACKAGE / PATH".padEnd(maxPkg),
    "REQ",
    "OPT",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        r.name.padEnd(maxName),
        r.displayName.padEnd(maxDisplay),
        r.package.padEnd(maxPkg),
        String(r.required).padStart(3),
        String(r.optional).padStart(3),
      ].join("  "),
    );
  }
}

async function runPluginList(options: {
  manifest?: string;
  dir?: string;
  json?: boolean;
  allowJsManifest?: boolean;
}): Promise<void> {
  const cwd = process.cwd();
  const allowJsManifest = Boolean(options.allowJsManifest);
  if (allowJsManifest) {
    console.warn(
      "Warning: --allow-js-manifest executes manifest.js/manifest.cjs files. Only use with trusted code.",
    );
  }
  let rows: PluginRow[];

  if (options.dir !== undefined) {
    rows = await listFromDirectory(options.dir, cwd, allowJsManifest);
    if (rows.length === 0 && options.dir) {
      console.error(
        `No plugin directories with ${allowJsManifest ? "manifest.json or manifest.js" : "manifest.json"} found in ${options.dir}`,
      );
      process.exit(1);
    }
  } else {
    const manifestPath = path.resolve(
      cwd,
      options.manifest ?? "appkit.plugins.json",
    );
    if (!fs.existsSync(manifestPath)) {
      console.error(`Manifest not found: ${manifestPath}`);
      console.error(
        "  appkit plugin list --manifest <path-to-manifest> or appkit plugin list --dir <plugins-directory>",
      );
      process.exit(1);
    }
    try {
      rows = listFromManifestFile(manifestPath);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
  }
}

export const pluginListCommand = new Command("list")
  .description("List plugins from appkit.plugins.json or a directory")
  .option(
    "-m, --manifest <path>",
    "Path to appkit.plugins.json",
    "appkit.plugins.json",
  )
  .option(
    "-d, --dir <path>",
    "Scan directory recursively for plugin folders (manifest.json by default)",
  )
  .option(
    "--allow-js-manifest",
    "Allow reading manifest.js/manifest.cjs (executes code; use only with trusted plugins)",
  )
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit plugin list
  $ appkit plugin list --json
  $ appkit plugin list --manifest custom-manifest.json
  $ appkit plugin list --dir plugins/`,
  )
  .action((opts) =>
    runPluginList(opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
