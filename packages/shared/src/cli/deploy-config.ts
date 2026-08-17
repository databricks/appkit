/**
 * Single source for the `app.yaml` + `databricks.yml` app-resource binding
 * contract, so the registry writer (`config-writer.ts`) and the doctor reader
 * (`bundle.ts`/`checks-wiring.ts`) on opposite ends of it can't drift apart.
 */

/** Canonical Databricks bundle config file name. */
export const DATABRICKS_YML_FILE = "databricks.yml";

/** Canonical Databricks Apps runtime config file name. */
export const APP_YAML_FILE = "app.yaml";

/** An `app.yaml` env entry: `- name: <env>`, `valueFrom: <binding name>`. */
export interface AppYamlEnvEntry {
  name: string;
  valueFrom: string;
}

/**
 * A `databricks.yml` app-resource binding under `resources.apps.<app>.resources[]`,
 * serialized as `{ name, <type>: { ...fields, permission? } }` (see {@link bindingToNode}).
 */
export interface ResourceBinding {
  /** Binding name — the `valueFrom` join key (equals the resourceKey). */
  name: string;
  /** Resource type key, e.g. `sql_warehouse` / `postgres`. */
  type: string;
  permission?: string;
  /** Binding fields, typically `${var.<variable>}` references. */
  fields: Record<string, string>;
}

/**
 * Encodes a binding into its `databricks.yml` node: the type is the single
 * non-`name` object key. Inverse of {@link bindingTypeOf}.
 */
export function bindingToNode(
  binding: ResourceBinding,
): Record<string, unknown> {
  const inner: Record<string, unknown> = { ...binding.fields };
  if (binding.permission) inner.permission = binding.permission;
  return { name: binding.name, [binding.type]: inner };
}

/**
 * Reads the type back out of a `databricks.yml` binding node — the single
 * non-`name` object-valued property; undefined if absent. See {@link bindingToNode}.
 */
export function bindingTypeOf(
  block: Record<string, unknown>,
): string | undefined {
  for (const [k, v] of Object.entries(block)) {
    if (k === "name") continue;
    if (v && typeof v === "object") return k;
  }
  return undefined;
}
