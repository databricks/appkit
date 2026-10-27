import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Command } from "commander";
import pc from "picocolors";
import { parseDocument } from "yaml";

import { APP_YAML_FILE } from "../../../deploy-config";
import { profileFromEnv } from "../../registry/add";
import {
  planHasContent,
  reportConfigWrite,
  validateBundle,
  writeConfig,
} from "../../registry/config-writer";
import { parseEnv, serializeEnvAppend } from "../../registry/env-reconcile";
import {
  AUTH_MODE_BOTH,
  AUTH_MODE_FIELD,
  AUTH_MODE_OBO,
  AUTH_MODE_SP,
  type AddPlan,
  type AuthMode,
  authKey,
  buildAddPlan,
  findMissingValues,
  type ManifestPlugin,
  type ManifestResource,
  type MissingValue,
  oboCapable,
  parseSetAuthModes,
  parseSetValues,
  resolveAuthModes,
  resourceConfigured,
  selectResources,
} from "./plan";
import { discoverIndexColumns, resolveDerivedValues } from "./resolve";

const MANIFEST_FILE = "appkit.plugins.json";
const SERVER_SUBDIRS = ["server", "api", "backend"];

interface AddOptions {
  set: string[];
  authMode?: string;
  cwd?: string;
  yes?: boolean;
  register?: boolean;
  profile?: string;
}

function loadPlugin(cwd: string, name: string): ManifestPlugin {
  const file = path.join(cwd, MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${MANIFEST_FILE} not found in ${cwd}; run \`appkit plugin sync --write\` first`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    plugins?: Record<string, ManifestPlugin>;
  };
  const plugins = manifest.plugins ?? {};
  const plugin = plugins[name];
  if (!plugin) {
    throw new Error(
      `unknown plugin "${name}"; available: ${Object.keys(plugins).sort().join(", ")}`,
    );
  }
  return {
    ...plugin,
    name,
    resources: {
      required: plugin.resources?.required ?? [],
      optional: plugin.resources?.optional ?? [],
    },
  };
}

function authModeLabel(mode: AuthMode): string {
  if (mode === AUTH_MODE_OBO) return "on behalf of user";
  if (mode === AUTH_MODE_BOTH) return "service principal and on behalf of user";
  return "service principal";
}

/** Bails out of the command on Ctrl+C in a prompt. */
async function answered<T>(value: T | symbol): Promise<T> {
  const { cancel, isCancel } = await import("@clack/prompts");
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return value as T;
}

/** Asks which optional resources to configure (they're only added with values). */
async function promptOptional(
  plugin: ManifestPlugin,
  values: Record<string, string>,
): Promise<ManifestResource[]> {
  const { confirm } = await import("@clack/prompts");
  const picked: ManifestResource[] = [];
  for (const r of plugin.resources.optional) {
    if (resourceConfigured(r, values)) continue;
    const yes = await answered(
      await confirm({
        message: `Configure ${r.alias}? ${pc.dim(`${r.description ?? ""} (optional)`)}`,
        initialValue: false,
      }),
    );
    if (yes) picked.push(r);
  }
  return picked;
}

/**
 * As `apps init`: one question for the app, and for "Mixed" one per
 * OBO-capable resource. Resources without --set authMode only.
 */
async function promptAuthModes(
  resources: ManifestResource[],
): Promise<Record<string, AuthMode>> {
  const capable = resources.filter(oboCapable);
  if (capable.length === 0) return {};
  const { log, select } = await import("@clack/prompts");
  const appMode = await answered(
    await select({
      message: "How should the app access resources?",
      options: [
        { value: AUTH_MODE_SP, label: "Service principal" },
        { value: AUTH_MODE_OBO, label: "On behalf of user" },
        { value: "mixed", label: "Mixed (choose per resource)" },
      ],
    }),
  );
  const modes: Record<string, AuthMode> = {};
  for (const r of capable) {
    modes[authKey(r)] =
      appMode === "mixed"
        ? await answered(
            await select<AuthMode>({
              message: `How should the app access ${r.alias}?`,
              options: [
                { value: AUTH_MODE_OBO, label: "On behalf of user" },
                { value: AUTH_MODE_SP, label: "Service principal" },
                { value: AUTH_MODE_BOTH, label: "Both" },
              ],
            }),
          )
        : (appMode as AuthMode);
    log.info(`${r.alias}: ${authModeLabel(modes[authKey(r)])}`);
  }
  for (const r of resources) {
    if (!oboCapable(r)) {
      log.info(`${r.alias}: ${authModeLabel(AUTH_MODE_SP)} (only option)`);
    }
  }
  return modes;
}

/** Prompts for each missing value, or fails on the first one when not interactive. */
async function fillMissing(
  missing: MissingValue[],
  values: Record<string, string>,
  interactive: boolean,
): Promise<void> {
  if (missing.length > 0 && !interactive) {
    const m = missing[0];
    throw new Error(
      `missing value for ${m.setKey}; use --set ${m.setKey}=value`,
    );
  }
  if (missing.length === 0) return;
  const { text } = await import("@clack/prompts");
  for (const m of missing) {
    const field = m.resource.fields?.[m.field];
    const value = await answered(
      await text({
        message: `${m.resource.alias}: ${m.field}`,
        placeholder: field?.description,
        validate: (v) =>
          !v?.trim() || /[\r\n]/.test(v) ? "Enter a value" : undefined,
      }),
    );
    values[`${m.resource.resourceKey}.${m.field}`] = value.trim();
  }
}

/**
 * Columns for the aiSearch default index: discovered from the workspace, else
 * prompted. Without a terminal it fails before anything is written, since the
 * app would not start in production without them.
 */
async function aiSearchColumns(
  values: Record<string, string>,
  profile: string | undefined,
  interactive: boolean,
): Promise<string[]> {
  const indexName = values["vector-search-index.id"];
  try {
    const columns = await discoverIndexColumns(indexName, profile);
    if (columns.length > 0) {
      console.log(pc.dim(`Index columns: ${columns.join(", ")}`));
      return columns;
    }
  } catch (err) {
    console.warn(
      pc.yellow(
        `Could not discover the columns of ${indexName}: ${(err as Error).message}`,
      ),
    );
  }
  if (!interactive) {
    throw new Error(
      `aiSearch needs the columns of ${indexName} to start in production; run with workspace access (--profile) or interactively to enter them`,
    );
  }
  const { text } = await import("@clack/prompts");
  const answer = await answered(
    await text({
      message: `Columns to return from ${indexName} (comma-separated)`,
      validate: (v) =>
        v?.split(",").some((c) => c.trim())
          ? undefined
          : "Enter at least one column",
    }),
  );
  return answer
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/** The env var agents falls back to for its model; serving binds it too. */
const AGENTS_MODEL_ENV = "DATABRICKS_SERVING_ENDPOINT_NAME";

/**
 * Env names in the plan already bound to something else: a different
 * non-empty value in .env, or an app.yaml entry with another valueFrom/value.
 */
export function envConflicts(cwd: string, plan: AddPlan): string[] {
  const dotEnv = fs.existsSync(path.join(cwd, ".env"))
    ? parseEnv(fs.readFileSync(path.join(cwd, ".env"), "utf-8"))
    : {};
  const appYamlFile = path.join(cwd, APP_YAML_FILE);
  const appEnv = new Map<string, string>();
  if (fs.existsSync(appYamlFile)) {
    const env = parseDocument(fs.readFileSync(appYamlFile, "utf-8")).toJSON()
      ?.env as
      | { name?: string; valueFrom?: string; value?: string }[]
      | undefined;
    for (const e of env ?? []) {
      if (e?.name) appEnv.set(e.name, JSON.stringify([e.valueFrom, e.value]));
    }
  }
  const out = new Set<string>();
  for (const e of plan.dotEnv) {
    if (dotEnv[e.env] && e.value && dotEnv[e.env] !== e.value) out.add(e.env);
  }
  for (const e of plan.appYamlEnv) {
    const want = JSON.stringify([
      "valueFrom" in e ? e.valueFrom : undefined,
      "value" in e ? e.value : undefined,
    ]);
    const have = appEnv.get(e.name);
    if (have !== undefined && have !== want) out.add(e.name);
  }
  return [...out];
}

async function runPluginAdd(name: string, opts: AddOptions): Promise<void> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  if (
    opts.authMode !== undefined &&
    opts.authMode !== AUTH_MODE_SP &&
    opts.authMode !== AUTH_MODE_OBO
  ) {
    throw new Error(
      `invalid --auth-mode value: "${opts.authMode}" (must be obo or sp; use --set <plugin>.<resourceKey>.${AUTH_MODE_FIELD}=both for a single resource)`,
    );
  }
  const plugin = loadPlugin(cwd, name);
  const values = parseSetValues(opts.set, plugin);
  const setModes = parseSetAuthModes(opts.set, plugin);
  const interactive = !opts.yes && Boolean(process.stdin.isTTY);

  let resources = selectResources(plugin, values);
  if (interactive) resources.push(...(await promptOptional(plugin, values)));

  const promptedModes =
    interactive && opts.authMode === undefined
      ? await promptAuthModes(
          resources.filter((r) => !(authKey(r) in setModes)),
        )
      : {};
  const { modes, keptSP } = resolveAuthModes(
    resources,
    setModes,
    promptedModes,
    opts.authMode,
  );
  if (keptSP.length > 0) {
    console.log(
      `Note: these resources cannot be accessed on behalf of the user and use the service principal: ${keptSP.join(", ")}`,
    );
  }

  const missingNow = () =>
    findMissingValues(plugin.name, resources, values, modes);
  // Values the user supplies come first: the derived ones need them.
  await fillMissing(
    missingNow().filter((m) => !m.resource.fields?.[m.field]?.resolve),
    values,
    interactive,
  );
  const profile = opts.profile ?? profileFromEnv(cwd);
  for (const r of resources) {
    try {
      for (const [k, v] of Object.entries(
        await resolveDerivedValues(r, values, profile),
      )) {
        values[k] ||= v;
      }
    } catch (err) {
      console.warn(
        pc.yellow(
          `Could not resolve derived values for ${r.alias}: ${(err as Error).message}`,
        ),
      );
    }
  }
  await fillMissing(missingNow(), values, interactive);
  resources = selectResources(plugin, values);

  let config = pluginConfig(
    plugin,
    resources,
    modes,
    plugin.name === "aiSearch" && opts.register !== false
      ? await aiSearchColumns(values, profile, interactive)
      : undefined,
  );

  const plan = buildAddPlan(plugin, resources, values, modes);

  // An env var holds one value: if another resource already binds one of
  // these names to something else, the new value would never reach the app.
  const conflicts = envConflicts(cwd, plan);
  const model = values["agents-serving-endpoint.name"];
  if (
    plugin.name === "agents" &&
    model &&
    conflicts.includes(AGENTS_MODEL_ENV)
  ) {
    // agents takes its model from defaultModel before that env var.
    config = { ...config, defaultModel: model };
    plan.dotEnv = plan.dotEnv.filter((e) => e.env !== AGENTS_MODEL_ENV);
    plan.appYamlEnv = plan.appYamlEnv.filter(
      (e) => e.name !== AGENTS_MODEL_ENV,
    );
    conflicts.splice(conflicts.indexOf(AGENTS_MODEL_ENV), 1);
    console.log(
      pc.dim(
        `${AGENTS_MODEL_ENV} is already used by another resource; agents gets its model as defaultModel instead.`,
      ),
    );
  }
  if (conflicts.length > 0) {
    throw new Error(
      `${conflicts.join(", ")} already set to a different resource or value in .env or app.yaml; nothing was written. Edit those entries by hand, then rerun.`,
    );
  }

  if (opts.register !== false) {
    await registerInServer(cwd, plugin, config ? toSource(config) : "");
  }

  const { appendToFile, readEnvFile } =
    await import("../../registry/env-writer.js");
  const envPath = path.join(cwd, ".env");
  const existing = readEnvFile(envPath);
  const dotEnv = plan.dotEnv.filter(
    (e, i) => plan.dotEnv.findIndex((x) => x.env === e.env) === i,
  );
  // Empty placeholders (`KEY=`) are filled in place; set values are kept.
  const filled = dotEnv.filter((e) => existing[e.env] === "" && e.value);
  if (filled.length > 0) {
    let content = fs.readFileSync(envPath, "utf-8");
    for (const e of filled) {
      // e.env is a validated identifier, so it is safe in the pattern.
      content = content.replace(
        new RegExp(`^(\\s*(?:export\\s+)?${e.env}\\s*=).*$`, "m"),
        (_, key: string) => key + e.value,
      );
    }
    fs.writeFileSync(envPath, content);
  }
  const newEnv = dotEnv.filter((e) => !(e.env in existing));
  appendToFile(envPath, serializeEnvAppend(newEnv));
  const updated = [...filled, ...newEnv].map((e) => e.env);
  if (updated.length > 0) {
    console.log(`${pc.green("Updated .env:")} ${updated.join(", ")}`);
  }

  if (planHasContent(plan)) {
    const result = writeConfig(cwd, plan);
    reportConfigWrite(result);
    if (result.databricksYmlChanged) {
      validateBundle(cwd, profile);
    }
  }
}

/** Plugins that default to the service principal unless told otherwise. */
const AUTH_OPTION_PLUGINS = new Set(["files", "aiSearch", "agents"]);
const OBO = "on-behalf-of-user";

/**
 * The `createApp` config for the plugin, or undefined for none. An OBO plan
 * leaves the service principal unbound, so plugins that default to it must be
 * told: files and agents read a plugin-level `auth`, aiSearch reads it per index. The
 * aiSearch `default` index takes DATABRICKS_VS_INDEX_NAME, and production
 * refuses to start without its `columns`.
 */
export function pluginConfig(
  plugin: ManifestPlugin,
  resources: ManifestResource[],
  modes: Record<string, AuthMode>,
  columns?: string[],
): Record<string, unknown> | undefined {
  let obo = false;
  if (AUTH_OPTION_PLUGINS.has(plugin.name)) {
    // The resources whose access the option governs. For agents that is the
    // model endpoint: skills load from their volume as the service principal
    // at boot whatever `auth` is, and the tracing experiment can't be OBO.
    // Elsewhere, every resource that can be accessed on behalf of the user.
    const governed = resources.filter(
      (r) =>
        oboCapable(r) &&
        (plugin.name !== "agents" || r.type === "serving_endpoint"),
    );
    const oboRes = governed.filter((r) => modes[authKey(r)] === AUTH_MODE_OBO);
    obo = oboRes.length > 0 && oboRes.length === governed.length;
    if (plugin.name === "agents") {
      for (const r of resources) {
        if (r.type === "volume" && modes[authKey(r)] === AUTH_MODE_OBO) {
          console.warn(
            pc.yellow(
              `agents loads skills from ${r.resourceKey} as the service principal at boot, which gets no access in obo mode; use --set agents.${r.resourceKey}.authMode=sp (or both).`,
            ),
          );
        }
      }
    }
    if (oboRes.length > 0 && !obo) {
      console.warn(
        pc.yellow(
          `${plugin.name} is registered with one auth setting for all its resources; set auth per volume or index in its config to mix on-behalf-of-user (${oboRes.map((r) => r.resourceKey).join(", ")}) with service principal access.`,
        ),
      );
    }
  }
  if (plugin.name === "aiSearch") {
    const index = { ...(columns && { columns }), ...(obo && { auth: OBO }) };
    return Object.keys(index).length > 0
      ? { indexes: { default: index } }
      : undefined;
  }
  return obo ? { auth: OBO } : undefined;
}

/** Source text for a config literal: `{ auth: "x", columns: ["a"] }`. */
export function toSource(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toSource).join(", ")}]`;
  if (v && typeof v === "object") {
    const props = Object.entries(v).map(
      ([k, x]) =>
        `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${toSource(x)}`,
    );
    return `{ ${props.join(", ")} }`;
  }
  return JSON.stringify(v);
}

async function registerInServer(
  cwd: string,
  plugin: ManifestPlugin,
  callArgs: string,
): Promise<void> {
  const serverRoot =
    SERVER_SUBDIRS.map((s) => path.join(cwd, s)).find((p) =>
      fs.existsSync(p),
    ) ?? cwd;
  // Lazy: server-register pulls in the @ast-grep/napi native addon.
  const { findServerFile, registerPluginInServer } =
    await import("../../registry/server-register.js");
  // The /beta subpath is AppKit's; other packages export their plugins as is.
  let importPath =
    plugin.stability === "beta" && plugin.package === "@databricks/appkit"
      ? `${plugin.package}/beta`
      : plugin.package;
  // Local plugins are recorded relative to the app root; imports resolve
  // relative to the server file.
  if (plugin.package.startsWith(".")) {
    const from = path.dirname(findServerFile(serverRoot) ?? serverRoot);
    const rel = path
      .relative(from, path.resolve(cwd, plugin.package))
      .split(path.sep)
      .join("/");
    importPath = rel.startsWith(".") ? rel : `./${rel}`;
  }
  const call = `${plugin.name}(${callArgs})`;
  const result = registerPluginInServer(
    serverRoot,
    importPath,
    plugin.name,
    callArgs,
  );
  const shown =
    result.file && path.relative(cwd, path.join(serverRoot, result.file));
  if (result.status === "wired") {
    console.log(`${pc.green("Registered")} ${call} in ${shown}`);
  } else if (result.status === "already") {
    console.log(pc.dim(`${plugin.name} is already registered in ${shown}`));
    if (callArgs) {
      console.warn(
        pc.yellow(
          `  Make sure it is configured as ${call} for the chosen auth mode.`,
        ),
      );
    }
  } else {
    console.log(
      pc.yellow(`Couldn't auto-register ${plugin.name}: ${result.reason}.`) +
        "\nAdd it to your server's createApp call:\n" +
        pc.dim(
          `  import { ${plugin.name} } from "${importPath}";\n` +
            `  createApp({ plugins: [${call}, /* ... */] });`,
        ),
    );
  }
}

export const pluginAddCommand = new Command("add")
  .description(
    "Add a plugin from appkit.plugins.json to the app: server registration, .env, app.yaml and databricks.yml",
  )
  .argument("<plugin>", "Plugin name, as in appkit.plugins.json")
  .option(
    "--set <plugin.resourceKey.field=value>",
    "Set resource values (format: plugin.resourceKey.field=value, can specify multiple)",
    (v: string, acc: string[]) => [...acc, v],
    [] as string[],
  )
  .option(
    "--auth-mode <mode>",
    "Default resource auth mode: obo (on behalf of the user) or sp (service principal). With obo, resources that cannot be accessed on behalf of the user use sp. Prompts if not provided in interactive mode, otherwise sp.",
  )
  .option("-C, --cwd <dir>", "Run as if started in <dir>")
  .option("-y, --yes", "Don't prompt; fail on missing required values")
  .option("--no-register", "Don't edit the server entry to register the plugin")
  .option(
    "-p, --profile <name>",
    "Databricks profile for bundle validate (defaults to the app's DATABRICKS_CONFIG_PROFILE)",
  )
  .addHelpText(
    "after",
    `
Resource configuration (--set), as in \`databricks apps init\`:
  Set resource values using --set plugin.resourceKey.field=value
  Keys are defined in the app's appkit.plugins.json manifest.
  Multi-field resources (e.g., database, secret) require all fields to be set together.
  Use --set plugin.resourceKey.authMode=obo|sp|both to choose how the app accesses a resource:
  on behalf of the user (obo), as the app's service principal (sp), or both.
  obo/both add the resource's user_api_scopes; sp/both bind it with its permission.

Existing entries in .env, app.yaml and databricks.yml are never overwritten.

Examples:
  $ appkit plugin add analytics --set analytics.sql-warehouse.id=abc123
  $ appkit plugin add analytics --auth-mode obo --set analytics.sql-warehouse.id=abc123
  $ appkit plugin add jobs --auth-mode obo --set jobs.job.authMode=sp --set jobs.job.id=42`,
  )
  .action((name: string, opts: AddOptions) =>
    runPluginAdd(name, opts).catch((err: Error) => {
      console.error(pc.red(err.message));
      process.exit(1);
    }),
  );
