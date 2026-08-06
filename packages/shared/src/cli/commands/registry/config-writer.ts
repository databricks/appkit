import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import {
  type AppYamlEnvEntry,
  type ConfigPlan,
  planHasContent,
  type ResourceBinding,
} from "./config-plan";

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
  if (fs.existsSync(file)) {
    return parseDocument(fs.readFileSync(file, "utf-8"));
  }
  return parseDocument("");
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
    seq.add(doc.createNode({ name: entry.name, valueFrom: entry.valueFrom }));
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

/**
 * Additively patches `databricks.yml`: adds bundle `variables`, the app
 * `resources` bindings, and the target-level variable values — each only if
 * not already present. Returns the binding/variable names added.
 */
function patchDatabricksYml(file: string, plan: ConfigPlan): string[] {
  if (plan.bundleVariables.length === 0 && plan.resourceBindings.length === 0) {
    return [];
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
    const app = ensureMap(doc, ["resources", "apps", "app"]);
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

  // Target-level variable values.
  const withValues = plan.bundleVariables.filter((v) => v.value !== undefined);
  if (withValues.length > 0) {
    const targetVars = ensureMap(doc, ["targets", "default", "variables"]);
    for (const v of withValues) {
      if (targetVars.has(v.name)) continue;
      targetVars.set(v.name, v.value);
    }
  }

  if (added.length > 0) fs.writeFileSync(file, doc.toString());
  return added;
}

/** Shapes a binding into the `{name, <type>: {…fields, permission}}` node. */
function bindingToNode(binding: ResourceBinding): Record<string, unknown> {
  const inner: Record<string, unknown> = { ...binding.fields };
  if (binding.permission) inner.permission = binding.permission;
  return { name: binding.name, [binding.type]: inner };
}

/**
 * Applies a config plan to `app.yaml` and `databricks.yml` in `cwd` via
 * comment-preserving additive patches. Never overwrites existing entries.
 */
export function writeConfig(cwd: string, plan: ConfigPlan): ConfigWriteResult {
  const appAdded = patchAppYaml(path.join(cwd, "app.yaml"), plan.appYamlEnv);
  const dbAdded = patchDatabricksYml(path.join(cwd, "databricks.yml"), plan);
  return {
    appYamlChanged: appAdded.length > 0,
    databricksYmlChanged: dbAdded.length > 0,
    added: [...new Set([...appAdded, ...dbAdded])],
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
