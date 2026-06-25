import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import {
  REGISTRY_ITEM_API_TEMPLATE,
  REGISTRY_ITEM_URL_TEMPLATE,
  REGISTRY_NAMESPACE,
  REGISTRY_REPO,
  type RegistryToken,
  resolveToken,
} from "./constants";

interface RegistryItemFile {
  path: string;
  content: string;
  type: string;
  /** Destination path relative to the project root. */
  target?: string;
}

interface RegistryItem {
  name: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files?: RegistryItemFile[];
}

function stripNamespace(component: string): string {
  const prefix = `${REGISTRY_NAMESPACE}/`;
  return component.startsWith(prefix)
    ? component.slice(prefix.length)
    : component;
}

/**
 * Fetches and parses a single registry item. When a token is present the GitHub
 * Contents API is used (works for the private/internal repo); otherwise the
 * public raw URL is used.
 */
async function fetchItem(
  name: string,
  token: RegistryToken | null,
): Promise<RegistryItem> {
  const template = token
    ? REGISTRY_ITEM_API_TEMPLATE
    : REGISTRY_ITEM_URL_TEMPLATE;
  const url = template.replace("{name}", name);
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token.value}`;
    headers.Accept = "application/vnd.github.raw";
  }

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    console.error(`Failed to fetch "${name}" from ${url}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (res.status === 404) {
    console.error(`Component "${name}" not found in ${REGISTRY_REPO}.`);
    if (!token) {
      console.error(
        "  If the registry repo is private, set APPKIT_REGISTRY_TOKEN (or GITHUB_TOKEN) to a token with read access.",
      );
    }
    process.exit(1);
  }
  if (res.status === 401 || res.status === 403) {
    console.error(
      `Access denied (HTTP ${res.status}) fetching "${name}" from ${REGISTRY_REPO}.`,
    );
    console.error("  Check that your token has read access to the repository.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Registry returned HTTP ${res.status} for "${name}".`);
    process.exit(1);
  }

  return (await res.json()) as RegistryItem;
}

/** Subdirectories that commonly hold the frontend in an AppKit app layout. */
const FRONTEND_SUBDIRS = ["client", "frontend", "web", "app"];

/**
 * Locates the frontend root to write components into. AppKit apps put the
 * client in a `client/` subdir (with its own components.json + src/), and the
 * CLI is typically run from the repo root. We prefer the dir containing
 * components.json, then a dir with a src/, checking the cwd and common
 * subdirs before falling back to cwd.
 */
function findFrontendRoot(cwd: string): string {
  if (fs.existsSync(path.join(cwd, "components.json"))) return cwd;
  for (const sub of FRONTEND_SUBDIRS) {
    if (fs.existsSync(path.join(cwd, sub, "components.json"))) {
      return path.join(cwd, sub);
    }
  }
  if (fs.existsSync(path.join(cwd, "src"))) return cwd;
  for (const sub of FRONTEND_SUBDIRS) {
    if (fs.existsSync(path.join(cwd, sub, "src"))) {
      return path.join(cwd, sub);
    }
  }
  return cwd;
}

/**
 * Finds the dir to install npm deps into: the nearest package.json walking up
 * from the frontend root to the cwd (a monorepo-style app has a single root
 * package.json while the client lives in client/).
 */
function findInstallDir(base: string, cwd: string): string {
  let dir = base;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (dir === cwd) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

/**
 * Resolves where a registry file is written, relative to the frontend root.
 * Uses the item's `target`, placing it under `src/` when that root has one.
 */
function resolveTarget(base: string, file: RegistryItemFile): string {
  let target = file.target ?? path.join("components", path.basename(file.path));
  if (!target.startsWith("src/") && fs.existsSync(path.join(base, "src"))) {
    target = path.join("src", target);
  }
  return path.join(base, target);
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
      `Dependency install exited with code ${result.status ?? "unknown"} — install manually if needed: ${deps.join(" ")}`,
    );
  }
}

async function runAdd(
  components: string[],
  opts: { force?: boolean; cwd?: string },
): Promise<void> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const base = findFrontendRoot(cwd);
  if (base !== cwd) {
    console.log(`Detected frontend root: ${path.relative(cwd, base)}/`);
  }

  const token = resolveToken();
  if (token) {
    console.log(
      `Using ${token.envName} to fetch from ${REGISTRY_REPO} (private).`,
    );
  }

  const names = components.map(stripNamespace);
  const items: RegistryItem[] = [];
  for (const name of names) {
    items.push(await fetchItem(name, token));
  }

  const deps = new Set<string>();
  const written: string[] = [];

  for (const item of items) {
    for (const dep of item.dependencies ?? []) deps.add(dep);

    // AppKit (Option A) items have no registry dependencies; warn rather than
    // silently dropping any a future item might declare.
    for (const rd of item.registryDependencies ?? []) {
      console.warn(
        `  Note: "${item.name}" declares registryDependency "${rd}" — add it separately if it isn't already present.`,
      );
    }

    for (const file of item.files ?? []) {
      const dest = resolveTarget(base, file);
      const existed = fs.existsSync(dest);
      if (existed && !opts.force) {
        console.error(
          `Refusing to overwrite ${path.relative(cwd, dest)} — pass --force to replace it.`,
        );
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.content);
      written.push(path.relative(cwd, dest));
      console.log(
        `${existed ? "Updated" : "Created"} ${path.relative(cwd, dest)}`,
      );
    }
  }

  installDependencies([...deps], findInstallDir(base, cwd));

  if (written.length > 0) {
    console.log(
      '\nReminder: import "@databricks/appkit-ui/styles.css" once at your app root so the component is themed.',
    );
  }
}

export const addCommand = new Command("add")
  .description("Add an AppKit registry component to your project")
  .argument("<component...>", "Component name(s), e.g. metric-card")
  .option("-f, --force", "Overwrite existing files")
  .option("-C, --cwd <dir>", "Run as if started in <dir>")
  .addHelpText(
    "after",
    `
No components.json is required. The frontend root is detected automatically
(a client/ subdir or a dir with components.json / src/), so you can run this
from the repo root. Files land under <frontend>/src/<target>; npm dependencies
install into the nearest package.json.

While the registry repo is private, a token with read access is used. It is
resolved automatically from \`gh auth token\` (if you're logged in with the
GitHub CLI), or from APPKIT_REGISTRY_TOKEN / GITHUB_TOKEN / GH_TOKEN.

Examples:
  $ appkit add metric-card
  $ appkit add metric-card data-table
  $ appkit add @appkit/metric-card`,
  )
  .action((components: string[], opts: { force?: boolean; cwd?: string }) =>
    runAdd(components, opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
