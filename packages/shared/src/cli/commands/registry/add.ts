import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import pc from "picocolors";
import {
  fetchRegistryItem,
  type RegistryItem,
  type RegistryItemFile,
  stripNamespace,
} from "./client";
import { REGISTRY_REPO, type RegistryToken, resolveToken } from "./constants";
import { extractRequirements, renderRequirements } from "./requirements";
import { registerPluginInServer } from "./server-register";

/** Subdirectories that commonly hold the frontend / server in an AppKit app. */
const FRONTEND_SUBDIRS = ["client", "frontend", "web", "app"];
const SERVER_SUBDIRS = ["server", "api", "backend"];

interface ManifestField {
  env?: string;
}
interface ManifestResource {
  fields?: Record<string, ManifestField>;
}
interface PluginManifestShape {
  name?: string;
  resources?: { required?: ManifestResource[]; optional?: ManifestResource[] };
}

function isDir(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

/** A registry item is a server plugin if it ships a manifest.json. */
function isPluginItem(item: RegistryItem): boolean {
  return (item.files ?? []).some(
    (f) => path.basename(f.target ?? f.path) === "manifest.json",
  );
}

/**
 * Locates the frontend root for UI components. AppKit apps put the client in a
 * client/ subdir (with its own components.json + src/); the CLI is typically
 * run from the repo root. Prefer the dir with components.json, then a src/.
 */
function findFrontendRoot(cwd: string): string {
  if (fs.existsSync(path.join(cwd, "components.json"))) return cwd;
  for (const sub of FRONTEND_SUBDIRS) {
    if (fs.existsSync(path.join(cwd, sub, "components.json"))) {
      return path.join(cwd, sub);
    }
  }
  if (isDir(path.join(cwd, "src"))) return cwd;
  for (const sub of FRONTEND_SUBDIRS) {
    if (isDir(path.join(cwd, sub, "src"))) return path.join(cwd, sub);
  }
  return cwd;
}

/** Locates the server root for plugins (the server/ subdir, else cwd). */
function findServerRoot(cwd: string): string {
  for (const sub of SERVER_SUBDIRS) {
    if (isDir(path.join(cwd, sub))) return path.join(cwd, sub);
  }
  return cwd;
}

/** Nearest dir with a package.json, walking up from start (for dep install). */
function findNearestPackageJson(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** UI file destination: target under the frontend root, placed in src/ if present. */
function resolveUiTarget(base: string, file: RegistryItemFile): string {
  let target = file.target ?? path.join("components", path.basename(file.path));
  if (!target.startsWith("src/") && isDir(path.join(base, "src"))) {
    target = path.join("src", target);
  }
  return path.join(base, target);
}

/** Env var names declared by a manifest's resources (required and optional). */
export function declaredEnvVars(manifest: PluginManifestShape): string[] {
  const envs: string[] = [];
  const resources = [
    ...(manifest.resources?.required ?? []),
    ...(manifest.resources?.optional ?? []),
  ];
  for (const res of resources) {
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
  const match = index?.content.match(/export\s*\{([^}]*)\}/);
  if (!match) return null;
  const names = match[1].split(",").map((s) => s.trim());
  // Prefer the camelCase toPlugin instance over the PascalCase class.
  return names.find((n) => /^[a-z]/.test(n)) ?? names[0] ?? null;
}

function detectPackageManager(cwd: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function installDependencies(deps: string[], cwd: string): void {
  if (deps.length === 0) return;
  if (!fs.existsSync(path.join(cwd, "package.json"))) {
    console.warn(
      pc.yellow(
        `No package.json found — install these manually: ${deps.join(" ")}`,
      ),
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
      pc.yellow(
        `Dependency install exited with code ${result.status ?? "unknown"} — install manually if needed: ${deps.join(" ")}`,
      ),
    );
  }
}

/** Runs `appkit plugin sync --write` via this same CLI binary. */
function runPluginSync(cwd: string): void {
  const result = spawnSync(
    process.execPath,
    [process.argv[1], "plugin", "sync", "--write"],
    { stdio: "inherit", cwd },
  );
  if (result.status !== 0) {
    console.warn(
      pc.yellow(
        "  Plugin sync did not complete cleanly — run `appkit plugin sync --write` manually.",
      ),
    );
  }
}

function writeItemFile(
  dest: string,
  content: string,
  force: boolean,
  cwd: string,
): void {
  const existed = fs.existsSync(dest);
  if (existed && !force) {
    console.error(
      pc.red(
        `Refusing to overwrite ${path.relative(cwd, dest)} — pass --force to replace it.`,
      ),
    );
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  const label = existed ? pc.yellow("Updated") : pc.green("Created");
  console.log(`${label} ${path.relative(cwd, dest)}`);
}

interface PluginSummary {
  importPath: string;
  exportName: string | null;
  envs: string[];
}

/**
 * Fetches the requested items plus their transitive registryDependencies.
 * Dependencies are resolved breadth-first and de-duplicated by name, so a
 * plugin that depends on another registry item pulls the whole graph in one
 * `add`. Explicitly-requested items keep their request order and come first.
 */
export async function resolveItems(
  names: string[],
  token: RegistryToken | null,
  fetchItem: (
    name: string,
    token: RegistryToken | null,
  ) => Promise<RegistryItem> = fetchRegistryItem,
): Promise<RegistryItem[]> {
  const seen = new Set<string>();
  const ordered: RegistryItem[] = [];
  const queue = [...names];

  while (queue.length > 0) {
    const name = stripNamespace(queue.shift() as string);
    if (seen.has(name)) continue;
    seen.add(name);
    const item = await fetchItem(name, token);
    ordered.push(item);
    for (const dep of item.registryDependencies ?? []) {
      const depName = stripNamespace(dep);
      if (!seen.has(depName)) queue.push(depName);
    }
  }

  return ordered;
}

async function runAdd(
  refs: string[],
  opts: { force?: boolean; cwd?: string; register?: boolean },
): Promise<void> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const token = resolveToken();
  if (token) {
    console.log(
      `Using ${token.envName} to fetch from ${REGISTRY_REPO} (private).`,
    );
  }

  const items = await resolveItems(refs, token);

  const hasUi = items.some((i) => !isPluginItem(i));
  const hasPlugin = items.some(isPluginItem);
  const frontendRoot = hasUi ? findFrontendRoot(cwd) : cwd;
  const serverRoot = hasPlugin ? findServerRoot(cwd) : cwd;
  if (hasUi && frontendRoot !== cwd) {
    console.log(pc.dim(`UI components → ${path.relative(cwd, frontendRoot)}/`));
  }
  if (hasPlugin && serverRoot !== cwd) {
    console.log(pc.dim(`Plugins → ${path.relative(cwd, serverRoot)}/`));
  }

  const deps = new Set<string>();
  let wroteUi = false;
  const pluginSummaries: PluginSummary[] = [];

  for (const item of items) {
    for (const dep of item.dependencies ?? []) deps.add(dep);

    if (isPluginItem(item)) {
      let manifest: PluginManifestShape = {};
      let pluginRel = path.join("plugins", item.name);
      for (const file of item.files ?? []) {
        const target =
          file.target ??
          path.join("plugins", item.name, path.basename(file.path));
        writeItemFile(
          path.join(serverRoot, target),
          file.content,
          Boolean(opts.force),
          cwd,
        );
        if (path.basename(target) === "manifest.json") {
          manifest = JSON.parse(file.content) as PluginManifestShape;
          pluginRel = path.dirname(target);
        }
      }
      const requirements = extractRequirements(item);
      if (requirements.length > 0) {
        console.log(`\n${renderRequirements(item, requirements)}`);
      }
      pluginSummaries.push({
        importPath: `./${pluginRel}`,
        exportName: pluginExportName(item),
        envs: declaredEnvVars(manifest),
      });
    } else {
      for (const file of item.files ?? []) {
        writeItemFile(
          resolveUiTarget(frontendRoot, file),
          file.content,
          Boolean(opts.force),
          cwd,
        );
        wroteUi = true;
      }
    }
  }

  installDependencies([...deps], findNearestPackageJson(cwd));

  if (hasPlugin) {
    console.log(pc.dim("\nRegistering plugins (appkit plugin sync)..."));
    runPluginSync(cwd);
  }

  if (wroteUi) {
    console.log(
      pc.dim(
        '\nReminder: import "@databricks/appkit-ui/styles.css" once at your app root so components are themed.',
      ),
    );
  }
  for (const s of pluginSummaries) {
    // Try to wire the plugin into the server's createApp call automatically;
    // fall back to printing the snippet when the shape isn't the standard one.
    let wired = false;
    if (opts.register !== false && s.exportName) {
      const result = registerPluginInServer(cwd, s.importPath, s.exportName);
      if (result.status === "wired") {
        console.log(
          `\n${pc.green("Registered")} ${s.exportName} in ${result.file}`,
        );
        wired = true;
      } else if (result.status === "already") {
        console.log(
          pc.dim(`\n${s.exportName} is already registered in ${result.file}`),
        );
        wired = true;
      }
    }
    if (!wired) {
      const imp = s.exportName ?? "<plugin>";
      console.log(
        `\n${pc.bold("Add this to your server's createApp call:")}\n` +
          pc.dim(
            `  import { ${imp} } from "${s.importPath}";\n` +
              `  const app = await createApp({ plugins: [${imp}(), /* ... */] });`,
          ),
      );
    }
    if (s.envs.length > 0) {
      console.log(
        `  ${pc.yellow("Required env var(s):")} ${s.envs.join(", ")}`,
      );
    }
  }
}

export const addCommand = new Command("add")
  .description("Add a UI component or server plugin from the AppKit registry")
  .argument("<item...>", "Registry item name(s), e.g. metric-card or hello")
  .option("-f, --force", "Overwrite existing files")
  .option("-C, --cwd <dir>", "Run as if started in <dir>")
  .option("--no-register", "Don't edit the server entry to register plugins")
  .addHelpText(
    "after",
    `
No components.json is required. Item type is detected automatically:
  • UI components → <frontend>/src/components/appkit/  (client/ detected)
  • Server plugins → <server>/plugins/<name>/, runs plugin sync, and registers
    them in your createApp call (use --no-register to skip the server edit)

The frontend/server roots are detected from common layouts, so you can run
this from the repo root. While the registry repo is private, a read token is
resolved from \`gh auth token\` or APPKIT_REGISTRY_TOKEN / GITHUB_TOKEN / GH_TOKEN.

Examples:
  $ appkit add metric-card           # UI component
  $ appkit add hello                 # server plugin
  $ appkit add metric-card hello     # mix in one call`,
  )
  .action(
    (
      items: string[],
      opts: { force?: boolean; cwd?: string; register?: boolean },
    ) =>
      runAdd(items, opts).catch((err) => {
        console.error(err);
        process.exit(1);
      }),
  );
