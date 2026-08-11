import path from "node:path";
import pc from "picocolors";
import type { RegistryItem } from "./client";

/**
 * A single resource field as declared in a plugin manifest. `origin` is the
 * computed classifier written by `plugin sync` (platform/static/cli/user) that
 * says how the value reaches the running app.
 */
export interface RequirementField {
  key: string;
  env?: string;
  /**
   * Computed classifier written by `plugin sync` — only present in a synced
   * manifest. Authored manifests omit it, so consumers must derive the
   * effective origin via {@link fieldOrigin} rather than reading this directly.
   */
  origin?: string;
  description?: string;
  /** Default literal value (static origin); pre-filled without prompting. */
  value?: string;
  /** Resolver key (cli origin), e.g. "postgres:host". */
  resolve?: string;
  /** Local-dev-only field; platform-injected at deploy time. */
  localOnly?: boolean;
}

/** A resource requirement flattened for display. */
export interface ResourceRequirementRow {
  type: string;
  resourceKey?: string;
  permission?: string;
  required: boolean;
  description?: string;
  fields: RequirementField[];
}

interface ManifestFieldShape {
  env?: string;
  origin?: string;
  description?: string;
  value?: string;
  resolve?: string;
  localOnly?: boolean;
}
interface ManifestResourceShape {
  type?: string;
  resourceKey?: string;
  permission?: string;
  description?: string;
  fields?: Record<string, ManifestFieldShape>;
}
interface ManifestShape {
  resources?: {
    required?: ManifestResourceShape[];
    optional?: ManifestResourceShape[];
  };
}

function toFields(
  fields: Record<string, ManifestFieldShape> | undefined,
): RequirementField[] {
  return Object.entries(fields ?? {}).map(([key, f]) => ({
    key,
    env: f.env,
    origin: f.origin,
    description: f.description,
    value: f.value,
    resolve: f.resolve,
    localOnly: f.localOnly,
  }));
}

function toRows(
  resources: ManifestResourceShape[] | undefined,
  required: boolean,
): ResourceRequirementRow[] {
  return (resources ?? []).map((r) => ({
    type: r.type ?? "unknown",
    resourceKey: r.resourceKey,
    permission: r.permission,
    required,
    description: r.description,
    fields: toFields(r.fields),
  }));
}

/** The manifest.json file shipped by a plugin item, or null for UI items. */
function findManifest(item: RegistryItem): ManifestShape | null {
  const file = (item.files ?? []).find(
    (f) => path.basename(f.target ?? f.path) === "manifest.json",
  );
  if (!file) return null;
  try {
    return JSON.parse(file.content) as ManifestShape;
  } catch {
    return null;
  }
}

/**
 * Extracts a plugin item's declared resource requirements (required first,
 * then optional). Returns an empty array for UI items or plugins that declare
 * no resources.
 */
export function extractRequirements(
  item: RegistryItem,
): ResourceRequirementRow[] {
  const manifest = findManifest(item);
  if (!manifest) return [];
  return [
    ...toRows(manifest.resources?.required, true),
    ...toRows(manifest.resources?.optional, false),
  ];
}

/**
 * Renders the resource requirements for an item as human-readable lines.
 * Returns a single "no resources" line when there are none, so callers can
 * print unconditionally.
 */
export function renderRequirements(
  item: RegistryItem,
  rows: ResourceRequirementRow[] = extractRequirements(item),
): string {
  if (rows.length === 0) {
    return pc.dim(`${item.name}: no resource requirements.`);
  }

  const lines: string[] = [pc.bold(`Resources required by ${item.name}:`)];
  for (const row of rows) {
    const tag = row.required ? pc.yellow("required") : pc.dim("optional");
    const perm = row.permission ? pc.dim(` [${row.permission}]`) : "";
    lines.push(`  ${pc.cyan(row.type)} (${tag})${perm}`);
    if (row.description) lines.push(`    ${pc.dim(row.description)}`);
    for (const field of row.fields) {
      if (!field.env) continue;
      const origin = field.origin ? pc.dim(` (${field.origin})`) : "";
      lines.push(`    - ${field.env}${origin}`);
    }
  }
  return lines.join("\n");
}

/**
 * Effective origin of a field. Mirrors what `plugin sync` computes so the
 * classification is correct whether we read a synced manifest (origin present)
 * or an authored one (origin absent — derive from localOnly/value/resolve).
 * Precedence matches the documented contract: localOnly > value > resolve.
 */
export function fieldOrigin(
  field: RequirementField,
): "platform" | "static" | "cli" | "user" {
  if (field.origin)
    return field.origin as "platform" | "static" | "cli" | "user";
  if (field.localOnly) return "platform";
  if (field.value !== undefined) return "static";
  if (field.resolve) return "cli";
  return "user";
}
