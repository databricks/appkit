import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Command } from "commander";
import pc from "picocolors";
import { parseDocument } from "yaml";
import { z } from "zod";

import { APP_YAML_FILE } from "../../../deploy-config";
import { profileFromEnv } from "../../registry/add";
import type { ConfigPlan } from "../../registry/config-plan";
import {
  assertBundleApp,
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
  fromPlan?: string;
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
export function envConflicts(
  cwd: string,
  plan: AddPlan,
  /** Plans of earlier plugins in the same run, not yet written. */
  pending: AddPlan[] = [],
): string[] {
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
  for (const p of pending) {
    for (const e of p.dotEnv) if (!dotEnv[e.env]) dotEnv[e.env] = e.value;
    for (const e of p.appYamlEnv) {
      if (!appEnv.has(e.name)) {
        appEnv.set(
          e.name,
          JSON.stringify([
            "valueFrom" in e ? e.valueFrom : undefined,
            "value" in e ? e.value : undefined,
          ]),
        );
      }
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

/** One plugin of a run: its name, its --set pairs and its default auth mode. */
export interface PluginRequest {
  name: string;
  set: string[];
  authMode?: string;
}

interface PreparedPlugin {
  plugin: ManifestPlugin;
  plan: AddPlan;
  config?: Record<string, unknown>;
}

/**
 * Everything for one plugin short of writing: prompts, derived values, the
 * file plan and its registration config. Throws on conflicts with the app's
 * files or with earlier plugins of the run (`pending`).
 */
async function preparePlugin(
  cwd: string,
  req: PluginRequest,
  opts: AddOptions,
  pending: AddPlan[],
): Promise<PreparedPlugin> {
  if (
    req.authMode !== undefined &&
    req.authMode !== AUTH_MODE_SP &&
    req.authMode !== AUTH_MODE_OBO
  ) {
    throw new Error(
      `invalid --auth-mode value: "${req.authMode}" (must be obo or sp; use --set <plugin>.<resourceKey>.${AUTH_MODE_FIELD}=both for a single resource)`,
    );
  }
  const plugin = loadPlugin(cwd, req.name);
  const values = parseSetValues(req.set, plugin);
  const setModes = parseSetAuthModes(req.set, plugin);
  const interactive = !opts.yes && Boolean(process.stdin.isTTY);

  let resources = selectResources(plugin, values);
  if (interactive) resources.push(...(await promptOptional(plugin, values)));

  const promptedModes =
    interactive && req.authMode === undefined
      ? await promptAuthModes(
          resources.filter((r) => !(authKey(r) in setModes)),
        )
      : {};
  const { modes, keptSP } = resolveAuthModes(
    resources,
    setModes,
    promptedModes,
    req.authMode,
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
  const conflicts = envConflicts(cwd, plan, pending);
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
        `${AGENTS_MODEL_ENV} is already used by another resource; agents gets the endpoint as defaultModel in its registration instead.`,
      ),
    );
  }
  if (conflicts.length > 0) {
    throw new Error(
      `${conflicts.join(", ")} already set to a different resource or value in .env or app.yaml; nothing was written. Edit those entries by hand, then rerun.`,
    );
  }

  return { plugin, plan, config };
}

/** Requests from `plugin add a b --set ...`: each plugin gets its own --set pairs. */
export function requestsFromArgs(
  names: string[],
  set: string[],
  authMode: string | undefined,
): PluginRequest[] {
  for (const sv of set) {
    const prefix = sv.split(".")[0];
    if (!names.includes(prefix)) {
      throw new Error(
        `--set "${sv}" is for "${prefix}", which this run doesn't add (${names.join(", ")})`,
      );
    }
  }
  return names.map((name) => ({
    name,
    set: set.filter((sv) => sv.split(".")[0] === name),
    authMode,
  }));
}

const dataPlanSchema = z.object({
  version: z.literal(1),
  plugins: z
    .array(
      z.object({
        name: z.string().min(1),
        authMode: z.enum([AUTH_MODE_OBO, AUTH_MODE_SP]).optional(),
        /** `resourceKey.field` (or `resourceKey.authMode`) → value. */
        set: z.record(z.string(), z.string()).optional(),
      }),
    )
    .min(1),
});

/** Requests from a data plan file (`.appkit/data-plan.json`, version 1). */
export function requestsFromPlan(file: string): PluginRequest[] {
  const parsed = dataPlanSchema.safeParse(
    JSON.parse(fs.readFileSync(file, "utf-8")),
  );
  if (!parsed.success) {
    throw new Error(
      `invalid data plan ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data.plugins.map((p) => ({
    name: p.name,
    authMode: p.authMode,
    set: Object.entries(p.set ?? {}).map(([k, v]) => `${p.name}.${k}=${v}`),
  }));
}

/**
 * Adds every requested plugin in one pass: all are planned first (nothing is
 * written if any fails), then each file is written at most once, so a dev
 * server watching them restarts once.
 */
async function runPluginAdd(names: string[], opts: AddOptions): Promise<void> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  if (
    opts.fromPlan &&
    (names.length > 0 || opts.set.length > 0 || opts.authMode)
  ) {
    throw new Error(
      "--from-plan can't be combined with plugin names, --set or --auth-mode",
    );
  }
  if (!opts.fromPlan && names.length === 0) {
    throw new Error("name at least one plugin, or pass --from-plan <file>");
  }
  const requests = opts.fromPlan
    ? requestsFromPlan(path.resolve(cwd, opts.fromPlan))
    : requestsFromArgs(names, opts.set, opts.authMode);
  const seen = new Set<string>();
  for (const r of requests) {
    if (seen.has(r.name)) throw new Error(`plugin "${r.name}" is listed twice`);
    seen.add(r.name);
  }

  // agents is planned last: it is the one plugin that adapts to an env clash
  // (see preparePlugin), so it must see the others' entries in any order.
  const ordered = [
    ...requests.filter((r) => r.name !== "agents"),
    ...requests.filter((r) => r.name === "agents"),
  ];
  const prepared: PreparedPlugin[] = [];
  for (const req of ordered) {
    prepared.push(
      await preparePlugin(
        cwd,
        req,
        opts,
        prepared.map((p) => p.plan),
      ),
    );
  }

  // Fail before any write rather than leave a partial install.
  assertBundleApp(cwd);

  if (opts.register === false) {
    for (const { plugin, config } of prepared) {
      if (!config) continue;
      // The config carries required settings (auth mode, columns, model).
      console.log(
        `${pc.bold("Register it with this config in your createApp call:")}\n` +
          pc.dim(`  ${plugin.name}(${toSource(config)})`),
      );
    }
  } else {
    await registerInServer(cwd, prepared);
  }

  const plans = prepared.map((p) => p.plan);
  await writeDotEnv(
    cwd,
    plans.flatMap((p) => p.dotEnv),
  );

  // Plugins can share a resource (same env var, variable and binding);
  // envConflicts already rejected any that differ, so keep the first.
  const byName = <T extends { name: string }>(xs: T[]) =>
    xs.filter((x, i) => xs.findIndex((y) => y.name === x.name) === i);
  const merged: ConfigPlan = {
    appYamlEnv: byName(plans.flatMap((p) => p.appYamlEnv)),
    bundleVariables: byName(plans.flatMap((p) => p.bundleVariables)),
    resourceBindings: byName(plans.flatMap((p) => p.resourceBindings)),
    userApiScopes: [...new Set(plans.flatMap((p) => p.userApiScopes ?? []))],
    unverifiedTypes: [...new Set(plans.flatMap((p) => p.unverifiedTypes))],
  };
  if (planHasContent(merged)) {
    const result = writeConfig(cwd, merged);
    reportConfigWrite(result);
    if (result.databricksYmlChanged) {
      validateBundle(cwd, opts.profile ?? profileFromEnv(cwd));
    }
  }
}

/**
 * Adds the entries to .env in one write: empty placeholders (`KEY=`) are
 * filled in place, new names appended, set values kept.
 */
async function writeDotEnv(
  cwd: string,
  entries: { env: string; value: string }[],
): Promise<void> {
  const { readEnvFile } = await import("../../registry/env-writer.js");
  const envPath = path.join(cwd, ".env");
  const existing = readEnvFile(envPath);
  const dotEnv = entries.filter(
    (e, i) => entries.findIndex((x) => x.env === e.env) === i,
  );
  const filled = dotEnv.filter((e) => existing[e.env] === "" && e.value);
  const newEnv = dotEnv.filter((e) => !(e.env in existing));
  if (filled.length === 0 && newEnv.length === 0) return;
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  for (const e of filled) {
    // e.env is a validated identifier, so it is safe in the pattern.
    content = content.replace(
      new RegExp(`^(\\s*(?:export\\s+)?${e.env}\\s*=).*$`, "m"),
      (_, key: string) => key + e.value,
    );
  }
  const append = serializeEnvAppend(newEnv);
  if (append) {
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    content += append;
  }
  fs.writeFileSync(envPath, content);
  console.log(
    `${pc.green("Updated .env:")} ${[...filled, ...newEnv].map((e) => e.env).join(", ")}`,
  );
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
    // files takes auth per volume too: a volume's key is the lowercased
    // suffix of its DATABRICKS_VOLUME_<KEY> env var (FilesPlugin.discoverVolumes).
    if (plugin.name === "files" && oboRes.length > 0 && !obo) {
      const keys = oboRes.map((r) => filesVolumeKey(r));
      if (keys.every(Boolean)) {
        return {
          volumes: Object.fromEntries(keys.map((k) => [k, { auth: OBO }])),
        };
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

/** The files plugin's volume key for a volume resource, from its env var. */
function filesVolumeKey(r: ManifestResource): string | undefined {
  const prefix = "DATABRICKS_VOLUME_";
  const env = Object.values(r.fields ?? {})
    .map((f) => f.env)
    .find((e) => e?.startsWith(prefix) && e.length > prefix.length);
  return env?.slice(prefix.length).toLowerCase();
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
  prepared: PreparedPlugin[],
): Promise<void> {
  const serverRoot =
    SERVER_SUBDIRS.map((s) => path.join(cwd, s)).find((p) =>
      fs.existsSync(p),
    ) ?? cwd;
  // Lazy: server-register pulls in the @ast-grep/napi native addon.
  const { findServerFile, registerPluginsInServer } =
    await import("../../registry/server-register.js");
  const serverFile = findServerFile(serverRoot);
  const entries = prepared.map(({ plugin, config }) => {
    // The /beta subpath is AppKit's; other packages export their plugins as is.
    let importPath =
      plugin.stability === "beta" && plugin.package === "@databricks/appkit"
        ? `${plugin.package}/beta`
        : plugin.package;
    // Local plugins are recorded relative to the app root; imports resolve
    // relative to the server file.
    if (plugin.package.startsWith(".")) {
      const from = path.dirname(serverFile ?? serverRoot);
      const rel = path
        .relative(from, path.resolve(cwd, plugin.package))
        .split(path.sep)
        .join("/");
      importPath = rel.startsWith(".") ? rel : `./${rel}`;
    }
    return {
      importPath,
      exportName: plugin.name,
      callArgs: config ? toSource(config) : "",
    };
  });
  const results = registerPluginsInServer(serverRoot, entries);
  results.forEach((result, i) => {
    const { importPath, exportName, callArgs } = entries[i];
    const call = `${exportName}(${callArgs})`;
    const shown =
      result.file && path.relative(cwd, path.join(serverRoot, result.file));
    if (result.status === "wired") {
      console.log(`${pc.green("Registered")} ${call} in ${shown}`);
    } else if (result.status === "already") {
      console.log(pc.dim(`${exportName} is already registered in ${shown}`));
      if (callArgs) {
        console.warn(
          pc.yellow(
            `  Make sure it is configured as ${call} for the chosen auth mode.`,
          ),
        );
      }
    } else {
      console.log(
        pc.yellow(`Couldn't auto-register ${exportName}: ${result.reason}.`) +
          "\nAdd it to your server's createApp call:\n" +
          pc.dim(
            `  import { ${exportName} } from "${importPath}";\n` +
              `  createApp({ plugins: [${call}, /* ... */] });`,
          ),
      );
    }
  });
}

/** A fresh `plugin add` command (commander keeps parsed values per instance). */
export const createPluginAddCommand = () =>
  new Command("add")
    .description(
      "Add plugins from appkit.plugins.json to the app: server registration, .env, app.yaml and databricks.yml, each written once",
    )
    .argument("[plugins...]", "Plugin names, as in appkit.plugins.json")
    .option(
      "--from-plan <file>",
      "Add the plugins listed in a data plan file (e.g. .appkit/data-plan.json, version 1)",
    )
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
    .option(
      "--no-register",
      "Don't edit the server entry to register the plugin",
    )
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

Several plugins can be added in one run; each file is written once, so a dev
server watching them restarts once. Rerunning with the same input changes nothing.
Existing entries in .env, app.yaml and databricks.yml are never overwritten.

Data plan file (--from-plan), version 1:
  { "version": 1,
    "plugins": [
      { "name": "analytics", "authMode": "obo",
        "set": { "sql-warehouse.id": "abc123" } },
      { "name": "genie", "set": { "genie-space.id": "s1", "genie-space.name": "Sales" } } ] }
  "set" keys are the --set keys without the plugin prefix ("authMode" works per
  resource, e.g. "sql-warehouse.authMode": "both"); "authMode" is the plugin's default.

Examples:
  $ appkit plugin add analytics --set analytics.sql-warehouse.id=abc123
  $ appkit plugin add analytics --auth-mode obo --set analytics.sql-warehouse.id=abc123
  $ appkit plugin add jobs --auth-mode obo --set jobs.job.authMode=sp --set jobs.job.id=42
  $ appkit plugin add analytics genie --set analytics.sql-warehouse.id=abc123 \\
      --set genie.genie-space.id=s1 --set genie.genie-space.name=Sales
  $ appkit plugin add --from-plan .appkit/data-plan.json --yes`,
    )
    .action((names: string[], opts: AddOptions) =>
      runPluginAdd(names, opts).catch((err: Error) => {
        console.error(pc.red(err.message));
        process.exit(1);
      }),
    );

export const pluginAddCommand = createPluginAddCommand();
