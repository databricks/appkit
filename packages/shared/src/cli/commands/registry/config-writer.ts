import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import pc from "picocolors";
import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

import {
  APP_YAML_FILE,
  type AppYamlEnvEntry,
  bindingToNode,
  DATABRICKS_YML_FILE,
} from "../../deploy-config";
import { type ConfigPlan, planHasContent } from "./config-plan";

export interface ConfigWriteResult {
  appYamlChanged: boolean;
  databricksYmlChanged: boolean;
  /** Env/binding names actually added (skipping ones already present). */
  added: string[];
  /** Resource types skipped for lack of a verified binding spec. */
  unverifiedTypes: string[];
}

/** Reads and parses a YAML file into a Document, or a fresh doc if absent. */
function loadDoc(file: string): ReturnType<typeof parseDocument> {
  if (!fs.existsSync(file)) return parseDocument("");
  const doc = parseDocument(fs.readFileSync(file, "utf-8"));
  if (doc.errors.length > 0) {
    throw new Error(
      `${path.basename(file)} is not valid YAML: ${doc.errors[0].message}`,
    );
  }
  return doc;
}

/**
 * Additively patches `app.yaml`'s `env:` list with entries not already present
 * (matched by `name`). Returns the names added.
 */
function patchAppYaml(file: string, entries: AppYamlEnvEntry[]): string[] {
  if (entries.length === 0) return [];
  const doc = loadDoc(file);
  let seq = doc.get("env") as YAMLSeq | undefined;
  if (!seq || typeof (seq as YAMLSeq).add !== "function") {
    doc.set("env", doc.createNode([]));
    seq = doc.get("env") as YAMLSeq;
  }

  const existingNames = new Set<string>();
  for (const item of seq.items) {
    const name = (item as YAMLMap)?.get?.("name");
    if (typeof name === "string") existingNames.add(name);
  }

  const added: string[] = [];
  for (const entry of entries) {
    if (existingNames.has(entry.name)) continue;
    seq.add(doc.createNode(entry));
    added.push(entry.name);
  }

  if (added.length > 0) fs.writeFileSync(file, doc.toString());
  return added;
}

/** Navigates/creates a nested map path, returning the leaf map. */
function ensureMap(
  doc: ReturnType<typeof parseDocument>,
  pathKeys: string[],
): YAMLMap {
  let node = doc.contents as unknown as YAMLMap;
  const walked: string[] = [];
  for (const key of pathKeys) {
    walked.push(key);
    let child = doc.getIn(walked) as YAMLMap | undefined;
    if (!child || typeof (child as YAMLMap).set !== "function") {
      doc.setIn(walked, doc.createNode({}));
      child = doc.getIn(walked) as YAMLMap;
    }
    node = child;
  }
  return node;
}

/** The bundle's only app, else `app`; throws on several apps with none named `app`. */
function appKey(doc: ReturnType<typeof parseDocument>): string {
  const keys = Object.keys(doc.toJSON()?.resources?.apps ?? {});
  if (keys.length === 1) return keys[0];
  if (keys.length === 0 || keys.includes("app")) return "app";
  throw new Error(
    `databricks.yml defines several apps (${keys.join(", ")}); add the resources to the right one by hand`,
  );
}

/** Throws before any write when app.yaml or databricks.yml can't be patched. */
export function preflightConfig(cwd: string): void {
  loadDoc(path.join(cwd, APP_YAML_FILE));
  appKey(loadDoc(path.join(cwd, DATABRICKS_YML_FILE)));
}

/** JSON with sorted keys, for comparing YAML nodes regardless of key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Bundle variables and bindings the plan would set differently from
 * databricks.yml (any target's value or a variable default) or from earlier
 * plans of the same run, which the additive writer would silently keep.
 */
export function bundleConflicts(
  cwd: string,
  plan: ConfigPlan,
  pending: ConfigPlan[] = [],
): string[] {
  const doc = loadDoc(path.join(cwd, DATABRICKS_YML_FILE));
  const json = (doc.toJSON() ?? {}) as {
    variables?: Record<string, { default?: unknown } | null>;
    targets?: Record<string, { variables?: Record<string, unknown> } | null>;
    resources?: { apps?: Record<string, { resources?: { name?: string }[] }> };
  };
  const values = new Map<string, Set<string>>();
  const addValue = (name: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (!values.has(name)) values.set(name, new Set());
    values.get(name)?.add(String(v));
  };
  for (const [name, v] of Object.entries(json.variables ?? {}))
    addValue(name, v?.default);
  for (const t of Object.values(json.targets ?? {})) {
    for (const [name, v] of Object.entries(t?.variables ?? {}))
      addValue(name, v);
  }
  const bindings = new Map<string, string>();
  for (const b of json.resources?.apps?.[appKey(doc)]?.resources ?? []) {
    if (b?.name) bindings.set(b.name, canonical(b));
  }
  for (const p of pending) {
    for (const v of p.bundleVariables)
      if (!values.has(v.name)) addValue(v.name, v.value);
    for (const b of p.resourceBindings) {
      if (!bindings.has(b.name))
        bindings.set(b.name, canonical(bindingToNode(b)));
    }
  }
  const out: string[] = [];
  for (const v of plan.bundleVariables) {
    const have = values.get(v.name);
    if (v.value !== undefined && have && [...have].some((x) => x !== v.value)) {
      out.push(`variable ${v.name}`);
    }
  }
  for (const b of plan.resourceBindings) {
    const have = bindings.get(b.name);
    if (have !== undefined && have !== canonical(bindingToNode(b))) {
      out.push(`binding ${b.name}`);
    }
  }
  return out;
}

/**
 * Additively patches `databricks.yml`: adds bundle `variables`, the app
 * `resources` bindings, and the target-level variable values — each only if
 * not already present. Returns the names added plus whether the file changed
 * (a target-value-only write changes the file without adding any names).
 */
function patchDatabricksYml(
  file: string,
  plan: ConfigPlan,
): { added: string[]; changed: boolean } {
  if (
    plan.bundleVariables.length === 0 &&
    plan.resourceBindings.length === 0 &&
    !plan.userApiScopes?.length
  ) {
    return { added: [], changed: false };
  }
  const doc = loadDoc(file);
  const added: string[] = [];

  // Top-level bundle variables.
  if (plan.bundleVariables.length > 0) {
    const vars = ensureMap(doc, ["variables"]);
    for (const v of plan.bundleVariables) {
      if (vars.has(v.name)) continue;
      const body: Record<string, string> = {};
      if (v.description) body.description = v.description;
      vars.set(v.name, doc.createNode(body));
      added.push(v.name);
    }
  }

  // App resource bindings.
  if (plan.resourceBindings.length > 0) {
    const app = ensureMap(doc, ["resources", "apps", appKey(doc)]);
    let bindings = app.get("resources") as YAMLSeq | undefined;
    if (!bindings || typeof (bindings as YAMLSeq).add !== "function") {
      app.set("resources", doc.createNode([]));
      bindings = app.get("resources") as YAMLSeq;
    }
    const existing = new Set<string>();
    for (const item of bindings.items) {
      const name = (item as YAMLMap)?.get?.("name");
      if (typeof name === "string") existing.add(name);
    }
    for (const binding of plan.resourceBindings) {
      if (existing.has(binding.name)) continue;
      bindings.add(doc.createNode(bindingToNode(binding)));
      added.push(binding.name);
    }
  }

  if (plan.userApiScopes?.length) {
    const app = ensureMap(doc, ["resources", "apps", appKey(doc)]);
    let scopes = app.get("user_api_scopes") as YAMLSeq | undefined;
    if (!scopes || typeof (scopes as YAMLSeq).add !== "function") {
      app.set("user_api_scopes", doc.createNode([]));
      scopes = app.get("user_api_scopes") as YAMLSeq;
    }
    const existing = new Set(scopes.toJSON() as unknown[]);
    for (const scope of plan.userApiScopes) {
      if (existing.has(scope)) continue;
      scopes.add(scope);
      added.push(scope);
    }
  }

  // Target-level variable values. Tracked separately from `added` because the
  // binding/top-level var may already exist (e.g. from scaffold) while the
  // target VALUE is still missing — in that case nothing is in `added` yet the
  // file still needs writing to persist the assigned value.
  let wroteTargetValue = false;
  const withValues = plan.bundleVariables.filter((v) => v.value !== undefined);
  if (withValues.length > 0) {
    const targetVars = ensureMap(doc, ["targets", "default", "variables"]);
    for (const v of withValues) {
      if (targetVars.has(v.name)) continue;
      targetVars.set(v.name, v.value);
      wroteTargetValue = true;
    }
  }

  const changed = added.length > 0 || wroteTargetValue;
  if (changed) fs.writeFileSync(file, doc.toString());
  return { added, changed };
}

/**
 * Applies a config plan to `app.yaml` and `databricks.yml` in `cwd` via
 * comment-preserving additive patches. Never overwrites existing entries.
 */
export function writeConfig(cwd: string, plan: ConfigPlan): ConfigWriteResult {
  const appAdded = patchAppYaml(path.join(cwd, APP_YAML_FILE), plan.appYamlEnv);
  const db = patchDatabricksYml(path.join(cwd, DATABRICKS_YML_FILE), plan);
  return {
    appYamlChanged: appAdded.length > 0,
    databricksYmlChanged: db.changed,
    added: [...new Set([...appAdded, ...db.added])],
    unverifiedTypes: plan.unverifiedTypes,
  };
}

/**
 * Runs `databricks bundle validate` as a post-write correctness gate. Returns
 * true when the config validates (or when the CLI is unavailable — a missing
 * CLI shouldn't fail an install). Surfaces validation errors to the user.
 */
export function validateBundle(cwd: string, profile?: string): boolean {
  const args = ["bundle", "validate"];
  if (profile) args.push("-p", profile);
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("databricks", args, { cwd, encoding: "utf-8" });
  } catch {
    console.warn(
      pc.yellow("  Skipped bundle validate (databricks CLI not found)."),
    );
    return true;
  }
  if (result.error) {
    console.warn(
      pc.yellow("  Skipped bundle validate (databricks CLI not found)."),
    );
    return true;
  }
  if (result.status !== 0) {
    console.warn(pc.yellow("  databricks bundle validate reported issues:"));
    if (result.stderr) console.warn(result.stderr.trim());
    return false;
  }
  return true;
}

/** Reports what the config write did, including any unverified-type warnings. */
export function reportConfigWrite(result: ConfigWriteResult): void {
  if (result.added.length > 0) {
    console.log(
      `${pc.green("Updated deploy config:")} ${result.added.join(", ")}`,
    );
  }
  if (result.unverifiedTypes.length > 0) {
    console.warn(
      pc.yellow(
        `  No databricks.yml binding written for: ${result.unverifiedTypes.join(", ")}. ` +
          "Add the resource binding manually before deploy.",
      ),
    );
  }
}

export { planHasContent };
