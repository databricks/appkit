import type { ResourceRequirementRow } from "./requirements";

/**
 * Deploy-config generation for a plugin's resources, reproducing what
 * `databricks apps init` renders. Verified byte-for-byte against golden
 * fixtures (see __fixtures__/) for the resource types listed in
 * {@link BINDING_SPECS}. Unverified types degrade safely: their env entries
 * are still produced (that shape is uniform), but the databricks.yml resource
 * binding is skipped with a warning rather than guessed.
 */

/** An `app.yaml` env entry: `- name: <env>` + `valueFrom: <resourceKey>`. */
export interface AppYamlEnvEntry {
  name: string;
  valueFrom: string;
}

/** A `databricks.yml` top-level bundle variable. */
export interface BundleVariable {
  name: string;
  description?: string;
  /** The value placed under targets.default.variables. */
  value?: string;
}

/** A `databricks.yml` app resource binding under resources.apps.app.resources. */
export interface ResourceBinding {
  /** Binding name (= resourceKey). */
  name: string;
  /** Resource type key, e.g. sql_warehouse / postgres. */
  type: string;
  permission?: string;
  /** Binding fields → `${var.<variable>}` references. */
  fields: Record<string, string>;
}

export interface ConfigPlan {
  appYamlEnv: AppYamlEnvEntry[];
  bundleVariables: BundleVariable[];
  resourceBindings: ResourceBinding[];
  /** Resource types encountered that have no verified binding spec. */
  unverifiedTypes: string[];
}

/**
 * Per-type rules for producing databricks.yml bundle variables and the app
 * resource binding. Only types verified against golden fixtures appear here.
 *
 * - `bindingFields`: field keys included in the resource binding (a subset of
 *   the manifest fields; e.g. postgres binds branch+database but not project).
 * - `variable(field)`: the bundle-variable name for a given field key.
 */
interface BindingSpec {
  bindingFields: string[];
  variable: (fieldKey: string) => string;
}

const BINDING_SPECS: Record<string, BindingSpec> = {
  // Verified against __fixtures__/analytics.
  sql_warehouse: {
    bindingFields: ["id"],
    // fixture: variable is `sql_warehouse_id`
    variable: (f) => `sql_warehouse_${f}`,
  },
  // Verified against __fixtures__/lakebase.
  postgres: {
    bindingFields: ["branch", "database"],
    // fixture: variables are `postgres_<fieldKey>` (project/branch/database)
    variable: (f) => `postgres_${f}`,
  },
};

/** Field keys that become bundle variables for a type (superset of binding). */
const VARIABLE_FIELDS: Record<string, string[]> = {
  sql_warehouse: ["id"],
  postgres: ["project", "branch", "database"],
};

/**
 * Builds the deploy-config plan for a set of resource rows. `values` supplies
 * the concrete values for the target-level bundle variables (keyed by the
 * manifest field's env var name for env-bearing fields, else by field key);
 * missing values leave the variable value undefined.
 */
export function buildConfigPlan(
  rows: ResourceRequirementRow[],
  values: Record<string, string> = {},
): ConfigPlan {
  const appYamlEnv: AppYamlEnvEntry[] = [];
  const bundleVariables: BundleVariable[] = [];
  const resourceBindings: ResourceBinding[] = [];
  const unverifiedTypes: string[] = [];
  const seenEnv = new Set<string>();
  const seenVar = new Set<string>();

  for (const row of rows) {
    // app.yaml env: every env-bearing field maps to a valueFrom = resourceKey.
    // Platform-injected fields (origin=platform) are NOT bound here — the
    // platform provides them directly (fixtures confirm only cli/user fields
    // appear in app.yaml env).
    const resourceKey = row.resourceKey ?? row.type;
    for (const field of row.fields) {
      if (!field.env || field.origin === "platform") continue;
      if (seenEnv.has(field.env)) continue;
      seenEnv.add(field.env);
      appYamlEnv.push({ name: field.env, valueFrom: resourceKey });
    }

    const spec = BINDING_SPECS[row.type];
    if (!spec) {
      if (!unverifiedTypes.includes(row.type)) unverifiedTypes.push(row.type);
      continue;
    }

    // Bundle variables (superset of binding fields for this type).
    const varFields = VARIABLE_FIELDS[row.type] ?? spec.bindingFields;
    for (const fieldKey of varFields) {
      const varName = spec.variable(fieldKey);
      if (seenVar.has(varName)) continue;
      seenVar.add(varName);
      const field = row.fields.find((f) => f.key === fieldKey);
      const valueKey = field?.env ?? fieldKey;
      bundleVariables.push({
        name: varName,
        description: field?.description,
        value: values[valueKey] ?? field?.value,
      });
    }

    // Resource binding: only the spec's binding fields, referencing ${var.X}.
    const fields: Record<string, string> = {};
    for (const fieldKey of spec.bindingFields) {
      fields[fieldKey] = `\${var.${spec.variable(fieldKey)}}`;
    }
    resourceBindings.push({
      name: resourceKey,
      type: row.type,
      permission: row.permission,
      fields,
    });
  }

  return { appYamlEnv, bundleVariables, resourceBindings, unverifiedTypes };
}

/** True when the plan has any deploy-config content to write. */
export function planHasContent(plan: ConfigPlan): boolean {
  return (
    plan.appYamlEnv.length > 0 ||
    plan.bundleVariables.length > 0 ||
    plan.resourceBindings.length > 0
  );
}
