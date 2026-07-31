/**
 * Reads `databricks.yml` + `app.yaml` for two things doctor can't get from
 * `appkit.plugins.json`:
 *
 *  1. **Provenance** — whether each binding references an existing resource
 *     (`${var.*}`/literal → `external`) or one this bundle creates
 *     (`${resources.<type>.<key>.*}` → `bundle-managed`).
 *  2. **Wiring** — the binding `name` joins the three files: `app.yaml`'s
 *     `valueFrom: <name>` must match a `databricks.yml` binding `name`.
 *
 * SDK-free; pure YAML parsing. Absent files degrade to empty results.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { ResourceOrigin } from "./types";
import { errorMessage } from "./utils";

export const DEFAULT_BUNDLE_FILE = "databricks.yml";
export const DEFAULT_APP_YAML_FILE = "app.yaml";

/** A `${resources.<type>.<key>.<field>}` reference — a bundle-created resource. */
const RESOURCES_REF = /\$\{resources\.([^.]+)\.([^.}]+)\.[^}]+\}/;

/** One app resource binding from `resources.apps.<app>.resources[]`. */
export interface BundleBinding {
  /** The binding name — the join key with `app.yaml` `valueFrom`. */
  name: string;
  /** The typed sub-key that names the kind (`sql_warehouse`, `genie_space`, …). */
  type?: string;
  origin: ResourceOrigin;
  /** For bundle-managed bindings: the `<type>.<key>` it references, if parseable. */
  ref?: { type: string; key: string };
}

export interface BundleInfo {
  /** Bindings under every app, keyed by binding name. */
  bindings: Map<string, BundleBinding>;
  /** `app.yaml` env var name → binding name (from `valueFrom`). */
  envToBinding: Map<string, string>;
  /** Declared bundle resource keys, as `"<type>.<key>"`, for ref-integrity. */
  declaredResources: Set<string>;
  /** True when a `databricks.yml` was found and parsed. */
  present: boolean;
}

interface AppResourceBlock {
  name?: string;
  [k: string]: unknown;
}
interface BundleAppBlock {
  resources?: AppResourceBlock[];
}
interface BundleDoc {
  resources?: {
    apps?: Record<string, BundleAppBlock>;
    [otherType: string]: Record<string, unknown> | undefined;
  };
}
interface AppYamlDoc {
  env?: Array<{ name?: string; valueFrom?: string }>;
}

/** The typed sub-key of a binding is its single non-`name` object property. */
function bindingType(block: AppResourceBlock): string | undefined {
  for (const [k, v] of Object.entries(block)) {
    if (k === "name") continue;
    if (v && typeof v === "object") return k;
  }
  return undefined;
}

/** Classifies a binding by its typed sub-key and origin: scanning its field
 * values for a `${resources.*}` reference (bundle-managed) vs anything else
 * (external). */
function classifyBinding(block: AppResourceBlock): {
  type?: string;
  origin: ResourceOrigin;
  ref?: { type: string; key: string };
} {
  const type = bindingType(block);
  const typed = type ? block[type] : undefined;
  if (typed && typeof typed === "object") {
    for (const value of Object.values(typed as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const m = value.match(RESOURCES_REF);
      if (m) {
        return {
          type,
          origin: "bundle-managed",
          ref: { type: m[1], key: m[2] },
        };
      }
    }
  }
  return { type, origin: "external" };
}

/**
 * Reads and parses a YAML file. Returns `null` when the file is absent (a
 * legitimate "no bundle" state); throws on invalid YAML, since silently
 * ignoring it would let doctor report a false all-clear.
 */
function readYaml<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return (yaml.load(fs.readFileSync(filePath, "utf-8")) ?? {}) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse ${path.basename(filePath)}: ${errorMessage(err)}`,
    );
  }
}

/**
 * Parses `databricks.yml` (+ `app.yaml`) into {@link BundleInfo}. Returns an
 * empty-but-`present:false` result when no bundle is found, so callers can treat
 * "no bundle" as "everything external" without special-casing.
 */
export function readBundleInfo(
  cwd: string = process.cwd(),
  bundleFile: string = DEFAULT_BUNDLE_FILE,
  appYamlFile: string = DEFAULT_APP_YAML_FILE,
): BundleInfo {
  const bindings = new Map<string, BundleBinding>();
  const envToBinding = new Map<string, string>();
  const declaredResources = new Set<string>();

  const doc = readYaml<BundleDoc>(path.resolve(cwd, bundleFile));
  if (!doc) {
    return { bindings, envToBinding, declaredResources, present: false };
  }

  for (const [type, group] of Object.entries(doc.resources ?? {})) {
    if (!group || typeof group !== "object") continue;
    for (const key of Object.keys(group))
      declaredResources.add(`${type}.${key}`);
  }

  for (const app of Object.values(doc.resources?.apps ?? {})) {
    for (const block of app.resources ?? []) {
      if (!block?.name) continue;
      const { type, origin, ref } = classifyBinding(block);
      bindings.set(block.name, {
        name: block.name,
        type,
        origin,
        ref,
      });
    }
  }

  const appYaml = readYaml<AppYamlDoc>(path.resolve(cwd, appYamlFile));
  for (const entry of appYaml?.env ?? []) {
    if (entry?.name && entry.valueFrom) {
      envToBinding.set(entry.name, entry.valueFrom);
    }
  }

  return { bindings, envToBinding, declaredResources, present: true };
}

/**
 * Resolves the origin for a target given its env vars, by walking
 * env var → binding name → binding origin. Returns undefined when the bundle
 * has nothing to say (so the target stays external by default).
 */
export function originForEnvVars(
  envVars: string[],
  info: BundleInfo,
): ResourceOrigin | undefined {
  if (!info.present) return undefined;
  for (const env of envVars) {
    const bindingName = info.envToBinding.get(env);
    if (!bindingName) continue;
    const binding = info.bindings.get(bindingName);
    if (binding) return binding.origin;
  }
  return undefined;
}
