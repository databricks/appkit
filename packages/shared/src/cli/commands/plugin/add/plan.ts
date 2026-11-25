import { DABS_BINDING_BY_TYPE } from "../../../../schemas/manifest";
import type { AppYamlEnvEntry, ResourceBinding } from "../../../deploy-config";
import type { BundleVariable, ConfigPlan } from "../../registry/config-plan";
import { isValidEnvName } from "../../registry/requirements";

// Port of the Databricks CLI's `apps init` resource handling (cmd/apps/init.go, libs/apps/generator).

export const AUTH_MODE_SP = "sp";
export const AUTH_MODE_OBO = "obo";
export const AUTH_MODE_BOTH = "both";
export type AuthMode =
  | typeof AUTH_MODE_SP
  | typeof AUTH_MODE_OBO
  | typeof AUTH_MODE_BOTH;

/** Reserved --set field that selects a resource's auth mode. */
export const AUTH_MODE_FIELD = "authMode";

export interface ManifestField {
  env?: string;
  description?: string;
  value?: string;
  localOnly?: boolean;
  bundleIgnore?: boolean;
  /** Derived-value resolver key, e.g. "postgres:host" (see resolve.ts). */
  resolve?: string;
}

export interface ManifestResource {
  type: string;
  alias: string;
  resourceKey: string;
  description?: string;
  permission?: string;
  fields?: Record<string, ManifestField>;
  scope?: string;
  appOnly?: boolean;
  binding?: Binding;
}

type FieldPair = readonly [string, string];
interface Binding {
  yamlKey: string;
  varFields: readonly FieldPair[];
  staticFields?: readonly FieldPair[];
}

/** The manifest's binding, else the built-in one for the type (as the CLI generator does). */
function bindingOf(r: ManifestResource): Binding | undefined {
  return (
    r.binding ??
    (DABS_BINDING_BY_TYPE as Record<string, Binding | undefined>)[r.type]
  );
}

/** A plugin entry of the app's appkit.plugins.json (the fields used here). */
export interface ManifestPlugin {
  name: string;
  package: string;
  stability?: string;
  scopes?: string[];
  resources: { required: ManifestResource[]; optional: ManifestResource[] };
}

/** Same identity as resource de-duplication: type + key. */
export function authKey(r: ManifestResource): string {
  return `${r.type}:${r.resourceKey}`;
}

/** Keys `resourceKey.field`, as the CLI's resourceValues map. */
function valueKey(r: ManifestResource, field: string): string {
  return `${r.resourceKey}.${field}`;
}

function fieldNames(r: ManifestResource): string[] {
  return Object.keys(r.fields ?? {}).sort();
}

function allResources(p: ManifestPlugin): ManifestResource[] {
  return [...p.resources.required, ...p.resources.optional];
}

/** Manifest fields the resource's databricks.yml binding references. */
function bindingVarFields(r: ManifestResource): string[] {
  return (bindingOf(r)?.varFields ?? []).map(([f]) => f);
}

/** The --set keys the manifest declares (authMode only for non-app-only resources). */
export function validSetKeys(plugin: ManifestPlugin): Set<string> {
  const keys = new Set<string>();
  for (const r of allResources(plugin)) {
    const prefix = `${plugin.name}.${r.resourceKey}.`;
    for (const f of [...fieldNames(r), ...bindingVarFields(r)])
      keys.add(prefix + f);
    if (!r.appOnly) keys.add(prefix + AUTH_MODE_FIELD);
  }
  return keys;
}

/** The error for a --set key the plugin manifest doesn't declare. */
function undeclaredKey(plugin: ManifestPlugin, sv: string): Error {
  const keys = validSetKeys(plugin);
  return new Error(
    `--set "${sv}" does not match a resource declared by plugin "${plugin.name}"; valid keys: ${[...keys].join(", ") || "(none, the plugin declares no resources)"}`,
  );
}

function splitSetKey(sv: string): {
  pluginName: string;
  resourceKey: string;
  field: string;
  value: string;
} {
  const eq = sv.indexOf("=");
  const key = eq === -1 ? "" : sv.slice(0, eq);
  if (!key) {
    throw new Error(
      `invalid --set format "${sv}", expected plugin.resourceKey.field=value`,
    );
  }
  const parts = key.split(".");
  if (parts.length < 3) {
    throw new Error(
      `invalid --set key "${key}", expected plugin.resourceKey.field`,
    );
  }
  return {
    pluginName: parts[0],
    resourceKey: parts[1],
    field: parts.slice(2).join("."),
    value: sv.slice(eq + 1),
  };
}

/** `--set plugin.resourceKey.field=value` → `resourceKey.field` → value; authMode pairs are skipped. */
export function parseSetValues(
  setValues: string[],
  plugin: ManifestPlugin,
): Record<string, string> {
  const rv: Record<string, string> = {};
  for (const sv of setValues) {
    const { pluginName, resourceKey, field, value } = splitSetKey(sv);
    if (field === AUTH_MODE_FIELD) continue;
    if (pluginName !== plugin.name) {
      throw new Error(
        `unknown plugin "${pluginName}" in --set "${sv}"; this command adds "${plugin.name}"`,
      );
    }
    if (!validSetKeys(plugin).has(`${pluginName}.${resourceKey}.${field}`)) {
      throw undeclaredKey(plugin, sv);
    }
    rv[`${resourceKey}.${field}`] = value;
  }

  for (const r of allResources(plugin)) {
    const checkable = fieldNames(r).filter(
      (f) => !r.fields?.[f].bundleIgnore && !r.fields?.[f].localOnly,
    );
    if (checkable.length <= 1) continue;
    const missing = checkable.filter((f) => !rv[valueKey(r, f)]);
    if (missing.length > 0 && missing.length < checkable.length) {
      throw new Error(
        `incomplete resource "${r.resourceKey}": missing fields [${missing.map((f) => valueKey(r, f)).join(" ")}] (all fields must be set together)`,
      );
    }
  }
  return rv;
}

/** Parses `--set plugin.resourceKey.authMode=obo|sp|both` into authKey → mode. */
export function parseSetAuthModes(
  setValues: string[],
  plugin: ManifestPlugin,
): Record<string, AuthMode> {
  const modes: Record<string, AuthMode> = {};
  for (const sv of setValues) {
    const { pluginName, resourceKey, field, value } = splitSetKey(sv);
    if (field !== AUTH_MODE_FIELD) continue;
    if (pluginName !== plugin.name) {
      throw new Error(
        `unknown plugin "${pluginName}" in --set "${sv}"; this command adds "${plugin.name}"`,
      );
    }
    const r = allResources(plugin).find((x) => x.resourceKey === resourceKey);
    if (!r) throw undeclaredKey(plugin, sv);
    if (
      value !== AUTH_MODE_SP &&
      value !== AUTH_MODE_OBO &&
      value !== AUTH_MODE_BOTH
    ) {
      throw new Error(
        `invalid auth mode "${value}" in --set "${sv}" (must be obo, sp, or both)`,
      );
    }
    if (r.appOnly) {
      throw new Error(
        `resource "${resourceKey}" of plugin "${plugin.name}" is always accessed by the app's service principal; remove --set ${sv}`,
      );
    }
    if (value !== AUTH_MODE_SP && !r.scope) {
      throw new Error(
        `resource "${resourceKey}" of plugin "${plugin.name}" cannot be accessed on behalf of the user; use ${plugin.name}.${resourceKey}.${AUTH_MODE_FIELD}=sp`,
      );
    }
    modes[authKey(r)] = value;
  }
  return modes;
}

/** True when the resource can be accessed on behalf of the user. */
export function oboCapable(r: ManifestResource): boolean {
  return Boolean(r.scope) && !r.appOnly;
}

/** Precedence: --set authMode, prompt, --auth-mode, sp; obo/both only are stored. */
export function resolveAuthModes(
  resources: ManifestResource[],
  setModes: Record<string, AuthMode>,
  promptedModes: Record<string, AuthMode>,
  defaultMode: string | undefined,
): { modes: Record<string, AuthMode>; keptSP: string[] } {
  const modes: Record<string, AuthMode> = {};
  const keptSP: string[] = [];
  for (const r of resources) {
    let mode: AuthMode | undefined =
      setModes[authKey(r)] ?? promptedModes[authKey(r)];
    if (mode === undefined && defaultMode === AUTH_MODE_OBO) {
      if (!oboCapable(r)) {
        keptSP.push(r.resourceKey);
        continue;
      }
      mode = AUTH_MODE_OBO;
    }
    if (mode === AUTH_MODE_OBO || mode === AUTH_MODE_BOTH) {
      modes[authKey(r)] = mode;
    }
  }
  return { modes, keptSP };
}

/** True when any field value of the resource is set. */
export function resourceConfigured(
  r: ManifestResource,
  values: Record<string, string>,
): boolean {
  return [...fieldNames(r), ...bindingVarFields(r)].some(
    (f) => values[valueKey(r, f)],
  );
}

/** Required resources plus optional ones that have a value. */
export function selectResources(
  plugin: ManifestPlugin,
  values: Record<string, string>,
): ManifestResource[] {
  return [
    ...plugin.resources.required,
    ...plugin.resources.optional.filter((r) => resourceConfigured(r, values)),
  ];
}

export interface MissingValue {
  resource: ManifestResource;
  field: string;
  /** The --set key that supplies it. */
  setKey: string;
}

/** Unset values: binding fields (sp/both) or env fields (obo), plus resolver fields local .env needs. */
export function findMissingValues(
  pluginName: string,
  resources: ManifestResource[],
  values: Record<string, string>,
  modes: Record<string, AuthMode>,
): MissingValue[] {
  const missing: MissingValue[] = [];
  for (const r of resources) {
    const fields =
      modes[authKey(r)] === AUTH_MODE_OBO
        ? fieldNames(r).filter(
            (f) => r.fields?.[f].env && !r.fields[f].localOnly,
          )
        : variableFields(r);
    const resolved = fieldNames(r).filter((f) => r.fields?.[f].resolve);
    for (const field of new Set([...fields, ...resolved])) {
      if (values[valueKey(r, field)] || r.fields?.[field]?.value) continue;
      missing.push({
        resource: r,
        field,
        setKey: `${pluginName}.${r.resourceKey}.${field}`,
      });
    }
  }
  return missing;
}

/** Fields that become bundle variables: manifest fields plus binding var fields. */
function variableFields(r: ManifestResource): string[] {
  const out = fieldNames(r).filter(
    (f) => !r.fields?.[f].bundleIgnore && !r.fields?.[f].localOnly,
  );
  const covered = new Set(fieldNames(r));
  for (const f of bindingVarFields(r)) {
    if (!covered.has(f)) out.push(f);
  }
  return out;
}

function varName(r: ManifestResource, field: string): string {
  return `${r.resourceKey.replaceAll("-", "_")}_${field}`;
}

export interface AddPlan extends ConfigPlan {
  /** .env lines to add (skipped later when the name is already present). */
  dotEnv: { env: string; value: string }[];
}

/** The file changes for the resources, as the CLI generator: OBO-only gets a literal value, no binding. */
export function buildAddPlan(
  plugin: ManifestPlugin,
  resources: ManifestResource[],
  values: Record<string, string>,
  modes: Record<string, AuthMode>,
): AddPlan {
  const dotEnv: AddPlan["dotEnv"] = [];
  const appYamlEnv: AppYamlEnvEntry[] = [];
  const bundleVariables: BundleVariable[] = [];
  const resourceBindings: ResourceBinding[] = [];
  const unverifiedTypes: string[] = [];
  const scopes: string[] = [];

  for (const r of resources) {
    const mode = modes[authKey(r)];
    const oboOnly = mode === AUTH_MODE_OBO;
    if ((mode === AUTH_MODE_OBO || mode === AUTH_MODE_BOTH) && r.scope) {
      scopes.push(r.scope);
    }

    for (const f of fieldNames(r)) {
      const field = r.fields?.[f] ?? {};
      if (!field.env || !isValidEnvName(field.env)) continue;
      const value = (values[valueKey(r, f)] || field.value || "").replace(
        /[\r\n]/g,
        "",
      );
      dotEnv.push({ env: field.env, value });
      if (field.localOnly) continue;
      appYamlEnv.push(
        oboOnly
          ? { name: field.env, value }
          : { name: field.env, valueFrom: r.resourceKey },
      );
    }

    if (oboOnly) continue;
    const binding = bindingOf(r);
    if (!binding) {
      unverifiedTypes.push(r.type);
      continue;
    }
    for (const f of variableFields(r)) {
      bundleVariables.push({
        name: varName(r, f),
        description: r.fields?.[f]?.description || r.description,
        value: values[valueKey(r, f)] || r.fields?.[f]?.value || undefined,
      });
    }
    const fields: Record<string, string> = {};
    for (const [mf, yf] of binding.varFields) {
      fields[yf] = `\${var.${varName(r, mf)}}`;
    }
    for (const [yf, v] of binding.staticFields ?? []) fields[yf] = v;
    resourceBindings.push({
      name: r.resourceKey,
      type: binding.yamlKey,
      permission: r.permission,
      fields,
    });
  }

  // Plugin scopes (e.g. genie) cover always-OBO routes, whatever the resources' mode.
  scopes.push(...(plugin.scopes ?? []));
  return {
    dotEnv,
    appYamlEnv,
    bundleVariables,
    resourceBindings,
    unverifiedTypes,
    userApiScopes: [...new Set(scopes)],
  };
}
