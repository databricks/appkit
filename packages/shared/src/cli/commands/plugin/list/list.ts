import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { validateManifest } from "../validate/validate-manifest";

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

export function listFromDirectory(dirPath: string, cwd: string): PluginRow[] {
  const resolved = path.resolve(cwd, dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return [];
  }
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const rows: PluginRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(resolved, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const obj = JSON.parse(raw);
      const result = validateManifest(obj);
      const manifest = result.valid ? result.manifest : null;
      if (!manifest) continue;
      const relPath = path.relative(cwd, path.dirname(manifestPath));
      const packagePath = relPath.startsWith(".") ? relPath : `./${relPath}`;
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
    } catch {
      // skip invalid manifests
    }
  }
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

function runPluginList(options: {
  manifest?: string;
  dir?: string;
  json?: boolean;
}): void {
  const cwd = process.cwd();
  let rows: PluginRow[];

  if (options.dir !== undefined) {
    rows = listFromDirectory(options.dir, cwd);
    if (rows.length === 0 && options.dir) {
      console.error(
        `No plugin directories with manifest.json found in ${options.dir}`,
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
    "Scan directory for plugin folders (each with manifest.json)",
  )
  .option("--json", "Output as JSON")
  .action(runPluginList);
