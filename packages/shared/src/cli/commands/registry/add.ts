import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import pc from "picocolors";
import {
  fetchRegistryItem,
  fetchVerifiedNames,
  type RegistryItem,
  type RegistryItemFile,
  stripNamespace,
} from "./client";
import {
  buildConfigPlan,
  collectBindingValueNeeds,
  planHasContent,
} from "./config-plan";
import {
  reportConfigWrite,
  validateBundle,
  writeConfig,
} from "./config-writer";
import { REGISTRY_REPO, type RegistryToken, resolveToken } from "./constants";
import {
  extractRequirements,
  type ResourceRequirementRow,
  renderRequirements,
} from "./requirements";

/** Subdirectories that commonly hold the frontend / server in an AppKit app. */
const FRONTEND_SUBDIRS = ["client", "frontend", "web", "app"];
const SERVER_SUBDIRS = ["server", "api", "backend"];

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

/**
 * Resolves a registry item's `target` under `base`, enforcing that the result
 * stays inside `base`. Registry items are untrusted remote data; a `target`
 * like `../../../.zshrc` or an absolute path could otherwise write files
 * anywhere on disk (arbitrary-write → RCE). Throws on any escape.
 */
export function resolveWithinBase(base: string, target: string): string {
  if (path.isAbsolute(target)) {
    throw new Error(`Refusing absolute file target from registry: ${target}`);
  }
  const baseResolved = path.resolve(base);
  const resolved = path.resolve(baseResolved, target);
  if (
    resolved !== baseResolved &&
    !resolved.startsWith(baseResolved + path.sep)
  ) {
    throw new Error(
      `Refusing file target that escapes the destination directory: ${target}`,
    );
  }
  return resolved;
}

/** UI file destination (relative to the frontend root): placed in src/ if present. */
function uiTargetPath(base: string, file: RegistryItemFile): string {
  let target = file.target ?? path.join("components", path.basename(file.path));
  if (!target.startsWith("src/") && isDir(path.join(base, "src"))) {
    target = path.join("src", target);
  }
  return target;
}

/** A valid, safe JS identifier — export names are written into the user's
 * server source, so anything else is rejected to prevent code injection from
 * a crafted registry `index.ts`. */
const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Best-effort: the `toPlugin` export name from the item's index.ts. Returns
 * null (caller falls back to printed instructions) unless the name is a plain
 * JS identifier — the item is untrusted remote content and the value is
 * interpolated into the user's server.ts. */
export function pluginExportName(item: RegistryItem): string | null {
  const index = (item.files ?? []).find(
    (f) => path.basename(f.target ?? f.path) === "index.ts",
  );
  const match = index?.content.match(/export\s*\{([^}]*)\}/);
  if (!match) return null;
  const names = match[1].split(",").map((s) => s.trim());
  // Prefer the camelCase toPlugin instance over the PascalCase class.
  const chosen = names.find((n) => /^[a-z]/.test(n)) ?? names[0];
  return chosen && JS_IDENTIFIER.test(chosen) ? chosen : null;
}

function detectPackageManager(cwd: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

/**
 * A safe npm dependency spec: `[@scope/]name` with an optional `@version`
 * range. Registry `dependencies` are untrusted remote data passed to the
 * package manager, so we reject anything that isn't a plain name+range —
 * blocks tarball/git URL specs (install-script RCE) and `-`-prefixed entries
 * that the PM would parse as flags (argument injection).
 */
const SAFE_DEP_SPEC =
  /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.\-+~^><=|* ]+)?$/i;

/** Splits deps into safe (installable) and rejected (surfaced to the user). */
export function partitionDeps(deps: string[]): {
  safe: string[];
  rejected: string[];
} {
  const safe: string[] = [];
  const rejected: string[] = [];
  for (const dep of deps) {
    if (dep.startsWith("-") || !SAFE_DEP_SPEC.test(dep)) rejected.push(dep);
    else safe.push(dep);
  }
  return { safe, rejected };
}

function installDependencies(deps: string[], cwd: string): void {
  if (deps.length === 0) return;

  const { safe, rejected } = partitionDeps(deps);
  if (rejected.length > 0) {
    console.warn(
      pc.yellow(
        `Skipping suspicious dependenc${rejected.length === 1 ? "y" : "ies"} from the registry (not a plain name@version): ${rejected.join(", ")}. Install manually if you trust them.`,
      ),
    );
  }
  if (safe.length === 0) return;

  if (!fs.existsSync(path.join(cwd, "package.json"))) {
    console.warn(
      pc.yellow(
        `No package.json found — install these manually: ${safe.join(" ")}`,
      ),
    );
    return;
  }
  const pm = detectPackageManager(cwd);
  const subcommand = pm === "npm" ? "install" : "add";
  console.log(`\nInstalling dependencies with ${pm}: ${safe.join(" ")}`);
  // `--` stops the PM from parsing any dep as a flag (defense in depth on top
  // of the SAFE_DEP_SPEC check above).
  const result = spawnSync(pm, [subcommand, "--", ...safe], {
    stdio: "inherit",
    cwd,
  });
  if (result.status !== 0) {
    console.warn(
      pc.yellow(
        `Dependency install exited with code ${result.status ?? "unknown"} — install manually if needed: ${safe.join(" ")}`,
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
  base: string,
  target: string,
  content: string,
  force: boolean,
  cwd: string,
): void {
  const dest = resolveWithinBase(base, target);
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
  // Breadth-first over the dependency graph, one level per iteration. Items in
  // a level are fetched concurrently (fetch latency is additive otherwise), but
  // levels stay ordered and dedup/cycle handling is unchanged: a name is marked
  // seen before its level is fetched, so it's never fetched or queued twice.
  let level = names.map(stripNamespace).filter((name) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  while (level.length > 0) {
    const items = await Promise.all(
      level.map(async (key) => {
        const item = await fetchItem(key, token);
        // The fetch key is the trustworthy identity — it's what the user
        // requested / a parent listed, and what the registry index keys
        // `verified` on. The item body's self-reported `name` is untrusted
        // remote data (a `verified: false` item could claim a verified name to
        // slip past the gate, or point its files at another item's dir), so
        // pin `name` to the key it was actually fetched under.
        item.name = key;
        return item;
      }),
    );
    ordered.push(...items);
    const next: string[] = [];
    for (const item of items) {
      for (const dep of item.registryDependencies ?? []) {
        const depName = stripNamespace(dep);
        if (seen.has(depName)) continue;
        seen.add(depName);
        next.push(depName);
      }
    }
    level = next;
  }

  return ordered;
}

interface AddOptions {
  force?: boolean;
  cwd?: string;
  register?: boolean;
  /** false = don't reconcile resource env vars into .env. */
  resources?: boolean;
  /** true = never prompt; use --env flags or leave unset (agent/CI). */
  yes?: boolean;
  /** Pre-supplied env values from repeated --env KEY=VALUE flags. */
  env?: Record<string, string>;
  /** Databricks profile passed to `bundle validate` after writing config. */
  profile?: string;
  /** true = install items the registry index doesn't mark verified. */
  allowUnverified?: boolean;
}

/**
 * Splits requested names into verified and unverified against the index's
 * verified set. When `verified` is null the index couldn't be read — we can't
 * prove anything is verified, so every name is treated as unverified (the gate
 * then decides whether to warn-and-continue or block). Names are compared with
 * the namespace stripped, matching how items are fetched.
 */
export function partitionVerified(
  refs: string[],
  verified: Set<string> | null,
): { verified: string[]; unverified: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const ref of refs) {
    const name = stripNamespace(ref);
    if (verified?.has(name)) ok.push(name);
    else bad.push(name);
  }
  return { verified: ok, unverified: bad };
}

async function runAdd(refs: string[], opts: AddOptions): Promise<void> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const token = resolveToken();
  if (token) {
    console.log(
      `Using ${token.envName} to fetch from ${REGISTRY_REPO} (private).`,
    );
  }

  // Resolve the full graph (requested items + their transitive
  // registryDependencies) up front. Fetching item JSON is read-only — nothing
  // is written to disk or installed until after the integrity gate below.
  const items = await resolveItems(refs, token);

  // Integrity gate: only items the registry index marks `verified` are trusted.
  // Checked over the *entire resolved set*, not just the requested names: a
  // verified item can declare an unverified registryDependency whose code would
  // otherwise be written into the user's app and wired into their server
  // without ever passing the gate. Fails closed — an unreadable index leaves
  // the verified set null, so every item counts as unverified.
  if (!opts.allowUnverified) {
    const verified = await fetchVerifiedNames(token);
    const { unverified } = partitionVerified(
      items.map((i) => i.name),
      verified,
    );
    if (unverified.length > 0) {
      const reason =
        verified === null
          ? "could not read the registry index to verify these items"
          : `not marked verified in ${REGISTRY_REPO}`;
      console.error(
        pc.red(
          `Refusing to add unverified item(s) (${reason}): ${unverified.join(", ")}.`,
        ),
      );
      console.error(
        pc.dim(
          "  Re-run with --allow-unverified if you trust the source; unverified items run code in your app.",
        ),
      );
      process.exit(1);
    }
  }

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
  const allRequirements: ResourceRequirementRow[] = [];

  for (const item of items) {
    for (const dep of item.dependencies ?? []) deps.add(dep);

    if (isPluginItem(item)) {
      let pluginRel = path.join("plugins", item.name);
      for (const file of item.files ?? []) {
        const target =
          file.target ??
          path.join("plugins", item.name, path.basename(file.path));
        writeItemFile(
          serverRoot,
          target,
          file.content,
          Boolean(opts.force),
          cwd,
        );
        if (path.basename(target) === "manifest.json") {
          pluginRel = path.dirname(target);
        }
      }
      const requirements = extractRequirements(item);
      if (requirements.length > 0) {
        console.log(`\n${renderRequirements(item, requirements)}`);
        allRequirements.push(...requirements);
      }
      pluginSummaries.push({
        importPath: `./${pluginRel}`,
        exportName: pluginExportName(item),
      });
    } else {
      for (const file of item.files ?? []) {
        writeItemFile(
          frontendRoot,
          uiTargetPath(frontendRoot, file),
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
  // Loaded lazily: server-register pulls in @ast-grep/napi (a native addon),
  // and this whole CLI is imported eagerly by index.ts, so a static import
  // would make every unrelated command (docs, lint, …) pay that cost.
  const registerPluginInServer =
    opts.register !== false && pluginSummaries.some((s) => s.exportName)
      ? (await import("./server-register.js")).registerPluginInServer
      : null;
  for (const s of pluginSummaries) {
    // Try to wire the plugin into the server's createApp call automatically;
    // fall back to printing the snippet when the shape isn't the standard one.
    let wired = false;
    if (registerPluginInServer && opts.register !== false && s.exportName) {
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
  }

  if (opts.resources !== false && allRequirements.length > 0) {
    // Loaded lazily: env-writer pulls in the workspace picker and, through it,
    // the Databricks SDK. index.ts imports this CLI eagerly, so a static import
    // would make every unrelated command pay the SDK load cost.
    const { collectBindingValues, reportEnvResolutions, syncEnv } =
      await import("./env-writer.js");
    console.log(pc.dim("\nReconciling resource env vars into .env..."));
    const resolutions = await syncEnv(allRequirements, {
      cwd,
      nonInteractive: Boolean(opts.yes),
      values: opts.env,
      profile: opts.profile,
    });
    reportEnvResolutions(resolutions);

    // Deploy config (app.yaml + databricks.yml). Values come from what the
    // user supplied for env fields (flags or prompts); other fields fall back
    // to their manifest defaults inside buildConfigPlan.
    const values: Record<string, string> = { ...(opts.env ?? {}) };
    for (const r of resolutions) {
      if (r.value !== undefined) values[r.env] = r.value;
    }
    // Binding fields with no env name (e.g. postgres project/branch/database)
    // never flow through .env, so collect them separately — else their
    // databricks.yml bundle variables stay unassigned and bundle validate fails.
    const bindingNeeds = collectBindingValueNeeds(allRequirements);
    if (bindingNeeds.length > 0) {
      const bindingValues = await collectBindingValues(bindingNeeds, {
        cwd,
        nonInteractive: Boolean(opts.yes),
        values: opts.env,
        profile: opts.profile,
      });
      Object.assign(values, bindingValues);
    }
    const plan = buildConfigPlan(allRequirements, values);
    if (planHasContent(plan)) {
      const result = writeConfig(cwd, plan);
      reportConfigWrite(result);
      if (result.databricksYmlChanged) validateBundle(cwd, opts.profile);
    }
    warnScopeNeeding(allRequirements);
  }
}

/**
 * v1 does not write `user_api_scopes` (deferred to the manifest scope
 * extension). Warn when an added plugin's resource type is known to need one,
 * so the user adds it before deploy.
 */
/** Resource types known to require a user_api_scope, and the scope each needs. */
export const SCOPE_BY_RESOURCE_TYPE: Record<string, string> = {
  genie_space: "dashboards.genie",
  serving_endpoint: "serving.serving-endpoints",
  // volumes/files-backed access uses files.files
  volume: "files.files",
};

/** Returns the user_api_scopes implied by a set of resource rows (deduped). */
export function scopesForResources(
  rows: ResourceRequirementRow[],
): Map<string, string> {
  const needed = new Map<string, string>();
  for (const row of rows) {
    const scope = SCOPE_BY_RESOURCE_TYPE[row.type];
    if (scope) needed.set(row.type, scope);
  }
  return needed;
}

function warnScopeNeeding(rows: ResourceRequirementRow[]): void {
  const needed = scopesForResources(rows);
  if (needed.size === 0) return;
  const list = [...needed.entries()]
    .map(([type, scope]) => `${type} → ${scope}`)
    .join(", ");
  console.warn(
    pc.yellow(
      `\n  Note: these resources may need a user_api_scope before deploy: ${list}.\n` +
        "  Add it under resources.apps.app.user_api_scopes in databricks.yml.",
    ),
  );
}

/** Commander reducer for repeatable `--env KEY=VALUE` flags. */
function collectEnvFlag(
  raw: string,
  acc: Record<string, string>,
): Record<string, string> {
  const eq = raw.indexOf("=");
  if (eq === -1) {
    console.error(`Ignoring --env "${raw}" (expected KEY=VALUE).`);
    return acc;
  }
  const key = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1);
  if (key) acc[key] = value;
  return acc;
}

export const addCommand = new Command("add")
  .description("Add a UI component or server plugin from the AppKit registry")
  .argument("<item...>", "Registry item name(s), e.g. metric-card or hello")
  .option("-f, --force", "Overwrite existing files")
  .option("-C, --cwd <dir>", "Run as if started in <dir>")
  .option("--no-register", "Don't edit the server entry to register plugins")
  .option("--no-resources", "Don't reconcile resource env vars into .env")
  .option("-y, --yes", "Don't prompt; use --env values or leave vars unset")
  .option(
    "--env <KEY=VALUE>",
    "Pre-set a resource env var (repeatable)",
    collectEnvFlag,
    {},
  )
  .option("-p, --profile <name>", "Databricks profile for bundle validate")
  .option(
    "--allow-unverified",
    "Add items the registry doesn't mark verified (runs untrusted code)",
  )
  .addHelpText(
    "after",
    `
No components.json is required. Item type is detected automatically:
  • UI components → <frontend>/src/components/appkit/  (client/ detected)
  • Server plugins → <server>/plugins/<name>/, runs plugin sync, and registers
    them in your createApp call (use --no-register to skip the server edit)

Server plugins declare Databricks resources. On add, their env vars are
reconciled into .env (and names into .env.example), and the deploy config
(app.yaml + databricks.yml resource bindings) is patched to match — existing
entries are never clobbered. Interactive by default; pass --yes for agents/CI
(uses --env values, leaves the rest unset) and --env KEY=VALUE to supply
values non-interactively. Pass --profile to validate the bundle after writing.

The frontend/server roots are detected from common layouts, so you can run
this from the repo root. While the registry repo is private, a read token is
resolved from \`gh auth token\` or APPKIT_REGISTRY_TOKEN / GITHUB_TOKEN / GH_TOKEN.

Examples:
  $ appkit add metric-card           # UI component
  $ appkit add hello                 # server plugin
  $ appkit add metric-card hello     # mix in one call
  $ appkit add analytics --yes --env DATABRICKS_WAREHOUSE_ID=abc123`,
  )
  .action((items: string[], opts: AddOptions) =>
    runAdd(items, opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
