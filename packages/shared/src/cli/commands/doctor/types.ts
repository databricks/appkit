/** Type definitions for the `appkit doctor` command. */

/** Layers run per resource, in order; a hard failure short-circuits the rest. */
export type CheckLayer = "auth" | "config" | "existence";

export type CheckStatus = "ok" | "warn" | "error" | "skipped";

export interface LayerResult {
  layer: CheckLayer;
  status: CheckStatus;
  detail?: string;
  /** Inferred guidance for fixing the finding. */
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
  /** Resolved field values keyed by manifest field name; unset fields omitted. */
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
