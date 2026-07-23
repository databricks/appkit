/** Type definitions for the `appkit doctor` command. */

/** Layers run per resource, in order; a hard failure short-circuits the rest. */
export type CheckLayer = "auth" | "config" | "existence";

export type CheckStatus = "ok" | "warn" | "error" | "skipped";

export interface LayerResult {
  layer: CheckLayer;
  status: CheckStatus;
  /** The raw finding (what happened). */
  detail?: string;
  /** Optional inferred guidance, rendered on its own line below `detail`. */
  hint?: string;
  /** Machine-readable code for `--json` consumers (e.g. `NOT_FOUND`). */
  code?: string;
}

export interface ResourceTarget {
  type: string;
  resourceKey: string;
  /** Human-readable label. */
  alias: string;
  plugin: string;
  /** Declared permission level; shown for context, not checked. */
  requiredPermission: string;
  /** Mandatory (vs optional) for the app. */
  required: boolean;
  envVars: string[];
  /** Field values resolved from `process.env`, keyed by manifest field name
   * (e.g. `id`, `name`). Unset fields are omitted. */
  fieldValues: Record<string, string>;
}

export interface ResourceCheckResult {
  target: ResourceTarget;
  /** Worst status across all layers run for this resource. */
  status: CheckStatus;
  layers: LayerResult[];
}

export interface AuthCheckResult {
  status: CheckStatus;
  detail?: string;
  /** Optional inferred guidance, rendered on its own line below `detail`. */
  hint?: string;
  code?: string;
  host?: string;
  profile?: string;
}

export interface DoctorReport {
  auth: AuthCheckResult;
  resources: ResourceCheckResult[];
  summary: { ok: number; warn: number; error: number; skipped: number };
}

export interface DoctorOptions {
  /** Path to the resolved template manifest (defaults to appkit.plugins.json). */
  manifest?: string;
  profile?: string;
  json?: boolean;
}
