import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import {
  fetchRegistryItem,
  type RegistryItem,
  type RegistryItemFile,
  stripNamespace,
} from "../../registry/client";
import { REGISTRY_REPO, resolveToken } from "../../registry/constants";

interface ManifestField {
  env?: string;
  description?: string;
}
interface ManifestResource {
  alias?: string;
  fields?: Record<string, ManifestField>;
}
interface PluginManifestShape {
  name?: string;
  resources?: { required?: ManifestResource[]; optional?: ManifestResource[] };
}

/** A registry item is a plugin if it ships a manifest.json. */
function isPluginItem(item: RegistryItem): boolean {
  return (item.files ?? []).some(
    (f) => path.basename(f.target ?? f.path) === "manifest.json",
  );
}

function manifestFile(item: RegistryItem): RegistryItemFile | undefined {
  return (item.files ?? []).find(
    (f) => path.basename(f.target ?? f.path) === "manifest.json",
  );
}

/** The directory a plugin's files are rooted at, e.g. `plugins/<name>`. */
function pluginDir(item: RegistryItem): string {
  const mf = manifestFile(item);
  const rel = mf?.target ?? mf?.path ?? `plugins/${item.name}/manifest.json`;
  return path.dirname(rel);
}

/** Required env vars declared by the manifest's required resources. */
function requiredEnvVars(manifest: PluginManifestShape): string[] {
  const envs: string[] = [];
  for (const res of manifest.resources?.required ?? []) {
    for (const field of Object.values(res.fields ?? {})) {
      if (field.env) envs.push(field.env);
    }
  }
  return envs;
}

/** Best-effort: the `toPlugin` export name from the item's index.ts. */
function pluginExportName(item: RegistryItem): string | null {
  const index = (item.files ?? []).find(
    (f) => path.basename(f.target ?? f.path) === "index.ts",
  );
  if (!index) return null;
  // Scaffolded index.ts: `export { ClassPlugin, exportName } from "./name";`
  const match = index.content.match(/export\s*\{([^}]*)\}/);
  if (!match) return null;
  const names = match[1].split(",").map((s) => s.trim());
  // Prefer the camelCase toPlugin instance (not the PascalCase class).
  return names.find((n) => /^[a-z]/.test(n)) ?? names[0] ?? null;
}

function runSync(repoRoot: string): void {
  const selfBin = process.argv[1];
  const result = spawnSync(
    process.execPath,
    [selfBin, "plugin", "sync", "--write"],
    { stdio: "inherit", cwd: repoRoot },
  );
  if (result.status !== 0) {
    console.warn(
      "  Plugin sync did not complete cleanly — run `appkit plugin sync --write` manually.",
    );
  }
}

async function runPluginAdd(
  plugins: string[],
  opts: { force?: boolean; cwd?: string },
): Promise<void> {
  const repoRoot = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const token = resolveToken();
  if (token) {
    console.log(
      `Using ${token.envName} to fetch from ${REGISTRY_REPO} (private).`,
    );
  }

  const names = plugins.map(stripNamespace);
  const items: RegistryItem[] = [];
  for (const name of names) {
    items.push(await fetchRegistryItem(name, token));
  }

  const deps = new Set<string>();
  const summaries: Array<{
    dir: string;
    exportName: string | null;
    envs: string[];
  }> = [];

  for (const item of items) {
    if (!isPluginItem(item)) {
      console.error(
        `"${item.name}" is not a plugin (no manifest.json). Use \`appkit add ${item.name}\` for UI components.`,
      );
      process.exit(1);
    }

    for (const dep of item.dependencies ?? []) deps.add(dep);

    let manifest: PluginManifestShape = {};
    for (const file of item.files ?? []) {
      // Plugin files carry explicit targets (e.g. plugins/<name>/index.ts),
      // written verbatim relative to the repo root — never under client/src.
      const target =
        file.target ??
        path.join("plugins", item.name, path.basename(file.path));
      const dest = path.join(repoRoot, target);
      const existed = fs.existsSync(dest);
      if (existed && !opts.force) {
        console.error(
          `Refusing to overwrite ${path.relative(repoRoot, dest)} — pass --force to replace it.`,
        );
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.content);
      console.log(
        `${existed ? "Updated" : "Created"} ${path.relative(repoRoot, dest)}`,
      );
      if (path.basename(target) === "manifest.json") {
        manifest = JSON.parse(file.content) as PluginManifestShape;
      }
    }

    summaries.push({
      dir: pluginDir(item),
      exportName: pluginExportName(item),
      envs: requiredEnvVars(manifest),
    });
  }

  if (deps.size > 0) {
    installDependencies([...deps], repoRoot);
  }

  console.log("\nRegistering plugins (appkit plugin sync)...");
  runSync(repoRoot);

  // Print the remaining manual wiring.
  console.log("\nNext steps:");
  for (const s of summaries) {
    const imp = s.exportName ?? "<plugin>";
    console.log(`\n  • ${s.dir}`);
    console.log(
      `    Register it in your server's createApp call:\n` +
        `      import { ${imp} } from "./${s.dir}";\n` +
        `      const app = await createApp({ plugins: [${imp}, /* ... */] });`,
    );
    if (s.envs.length > 0) {
      console.log(`    Set required env var(s): ${s.envs.join(", ")}`);
    }
  }
}

function detectPackageManager(cwd: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function installDependencies(deps: string[], cwd: string): void {
  if (!fs.existsSync(path.join(cwd, "package.json"))) {
    console.warn(
      `No package.json found — install these manually: ${deps.join(" ")}`,
    );
    return;
  }
  const pm = detectPackageManager(cwd);
  const subcommand = pm === "npm" ? "install" : "add";
  console.log(`\nInstalling dependencies with ${pm}: ${deps.join(" ")}`);
  const result = spawnSync(pm, [subcommand, ...deps], {
    stdio: "inherit",
    cwd,
  });
  if (result.status !== 0) {
    console.warn(
      `Dependency install exited with code ${result.status ?? "unknown"} — install manually if needed.`,
    );
  }
}

export const pluginAddCommand = new Command("add")
  .description("Add a plugin from the AppKit registry")
  .argument("<plugin...>", "Plugin name(s) from the registry")
  .option("-f, --force", "Overwrite existing files")
  .option("-C, --cwd <dir>", "Run as if started in <dir>")
  .addHelpText(
    "after",
    `
Fetches a plugin from the registry, writes it under plugins/<name>/, installs
npm dependencies, runs \`plugin sync\`, then prints the server-registration
snippet and any required env vars.

Examples:
  $ appkit plugin add hello
  $ appkit plugin add @appkit/hello`,
  )
  .action((plugins: string[], opts: { force?: boolean; cwd?: string }) =>
    runPluginAdd(plugins, opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
